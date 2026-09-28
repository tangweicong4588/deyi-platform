/**
 * kernel/kms.mjs —— V2.16：敏感字段落库加密（KMS 接口）。
 *
 * - 本地 provider：AES-256-GCM 信封加密（envelope encryption）。
 *   每字段随机 DEK（32B）→ KEK（环境变量 FIELD_ENCRYPTION_KEY，base64 32B）包裹 DEK。
 *   信封格式：`enc:v1:<kekId>:<b64(iv|wrappedDek|tag)>.<b64(iv|ct|tag)>`
 * - 密钥轮换：kekId 标识版本；FIELD_ENCRYPTION_KEY_PREVIOUS 保留旧 key（`id:base64` 逗号分隔），
 *   解密时按 kekId 找 key；`rotate()` 用当前 key 重包；`rotateSweep()` 批量扫表。
 * - 云 KMS 预留：KMS_PROVIDER 非 local 时显式 NOT_IMPLEMENTED（接口已预留 wrap/unwrap 替换点）。
 * - 密钥读取是 live 的（直接读 process.env），轮换无需重启进程。
 * - 安全边界：防拖库直接可读；不防运行时内存 dump；不做全列加密。
 * - fail-closed：写路径无 key 直接 503，不静默落明文。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Errors } from './errors.mjs';

export class KmsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KmsError';
    this.code = code;
  }
}

const ENVELOPE_RE = /^enc:v1:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/;

function parseKey(raw, label) {
  if (!raw) return null;
  let buf;
  try {
    buf = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new KmsError('BAD_KEY', `${label} 不是合法 base64`);
  }
  if (buf.length !== 32) {
    throw new KmsError('BAD_KEY', `${label} 解码后不是 32 字节（AES-256 需要 32B），实际 ${buf.length}B`);
  }
  return buf;
}

/** live 读取（支持无重启轮换） */
function readKeyring() {
  const provider = (process.env.KMS_PROVIDER || 'local').toLowerCase();
  if (provider !== 'local') {
    throw new KmsError('NOT_IMPLEMENTED',
      `KMS_PROVIDER=${provider} 尚未实现：云 KMS 对接预留了 wrap/unwrap 替换点，当前仅 local 可用`);
  }
  const currentId = process.env.FIELD_ENCRYPTION_KEY_ID || 'local-1';
  const current = parseKey(process.env.FIELD_ENCRYPTION_KEY, 'FIELD_ENCRYPTION_KEY');
  const previous = new Map(); // kekId -> Buffer
  for (const item of (process.env.FIELD_ENCRYPTION_KEY_PREVIOUS || '').split(',')) {
    const t = item.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) throw new KmsError('BAD_KEY', `FIELD_ENCRYPTION_KEY_PREVIOUS 项格式应为 id:base64: ${t.slice(0, 20)}`);
    previous.set(t.slice(0, i), parseKey(t.slice(i + 1), `FIELD_ENCRYPTION_KEY_PREVIOUS[${t.slice(0, i)}]`));
  }
  return { provider, currentId, current, previous };
}

function seal(kek, plaintext) {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  const payload = Buffer.concat([iv, ct, tag]).toString('base64');
  const iv2 = randomBytes(12);
  const w = createCipheriv('aes-256-gcm', kek, iv2);
  const wrapped = Buffer.concat([w.update(dek), w.final()]);
  const wtag = w.getAuthTag();
  const wrappedB64 = Buffer.concat([iv2, wrapped, wtag]).toString('base64');
  return { wrappedB64, payload };
}

function unseal(kek, wrappedB64, payloadB64) {
  const w = Buffer.from(wrappedB64, 'base64');
  const iv2 = w.subarray(0, 12);
  const wtag = w.subarray(w.length - 16);
  const wrapped = w.subarray(12, w.length - 16);
  const dw = createDecipheriv('aes-256-gcm', kek, iv2);
  dw.setAuthTag(wtag);
  const dek = Buffer.concat([dw.update(wrapped), dw.final()]);
  const p = Buffer.from(payloadB64, 'base64');
  const iv = p.subarray(0, 12);
  const tag = p.subarray(p.length - 16);
  const ct = p.subarray(12, p.length - 16);
  const dc = createDecipheriv('aes-256-gcm', dek, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(ct), dc.final()]).toString('utf8');
}

function parseEnvelope(envelope) {
  const m = ENVELOPE_RE.test(envelope || '') ? envelope.match(ENVELOPE_RE) : null;
  if (!m) throw new KmsError('NOT_ENCRYPTED', '不是合法的加密信封（期望 enc:v1:<kekId>:…）');
  return { kekId: m[1], wrappedB64: m[2], payloadB64: m[3] };
}

function toHttpError(e) {
  if (e.code === 'NOT_IMPLEMENTED' || e.code === 'BAD_KEY' || e.code === 'KEY_MISSING') {
    return Errors.serviceUnavailable(`字段加密不可用：${e.message}`, { code: 'FIELD_ENCRYPTION_UNAVAILABLE' });
  }
  if (e.code === 'DECRYPT_FAILED' || e.code === 'NOT_ENCRYPTED') {
    return Errors.internal(`字段解密失败：${e.message}`, { code: 'FIELD_DECRYPT_FAILED' });
  }
  return Errors.internal(`KMS 异常：${e.message}`, { code: 'KMS_ERROR' });
}

export const kms = {
  /** 是否为本模块产生的密文 */
  isEncrypted: (v) => typeof v === 'string' && v.startsWith('enc:v1:'),

  /** 加密。无 key 时 fail-closed（503），不静默落明文。 */
  encrypt(plaintext) {
    let ring;
    try {
      ring = readKeyring();
    } catch (e) {
      throw toHttpError(e);
    }
    if (!ring.current) {
      throw Errors.serviceUnavailable(
        'FIELD_ENCRYPTION_KEY 未配置：敏感字段无法加密存储（fail-closed，不落明文）',
        { code: 'FIELD_ENCRYPTION_UNCONFIGURED' });
    }
    try {
      const { wrappedB64, payload } = seal(ring.current, String(plaintext));
      return `enc:v1:${ring.currentId}:${wrappedB64}.${payload}`;
    } catch (e) {
      throw toHttpError(new KmsError('ENCRYPT_FAILED', e.message));
    }
  },

  /** 解密。信封非法/篡改 → FIELD_DECRYPT_FAILED（调用方映射为业务错误，如 TOTP 401）。 */
  decrypt(envelope) {
    let ring;
    try {
      ring = readKeyring();
      var { kekId, wrappedB64, payloadB64 } = parseEnvelope(envelope);
    } catch (e) {
      throw toHttpError(e);
    }
    const kek = kekId === ring.currentId ? ring.current : ring.previous.get(kekId);
    if (!kek) {
      throw Errors.serviceUnavailable(
        `字段加密 key 缺失：kekId=${kekId} 不在当前/历史 key 中（需恢复 FIELD_ENCRYPTION_KEY_PREVIOUS）`,
        { code: 'FIELD_ENCRYPTION_KEY_MISSING' });
    }
    try {
      return unseal(kek, wrappedB64, payloadB64);
    } catch {
      throw toHttpError(new KmsError('DECRYPT_FAILED', '认证解密失败（数据被篡改或 key 不匹配）'));
    }
  },

  /**
   * 轮换单个信封到当前 key。已是当前 keyId 则原样返回 { rotated: false }。
   * 供 rotateSweep 与 lazy 迁移使用。
   */
  rotate(envelope) {
    const { kekId } = parseEnvelope(envelope);
    const ring = readKeyring();
    if (kekId === ring.currentId) return { envelope, rotated: false };
    const plaintext = this.decrypt(envelope);
    return { envelope: this.encrypt(plaintext), rotated: true };
  },

  /** 运维可见状态（不含 key 材料） */
  status() {
    const ring = readKeyring();
    return {
      provider: ring.provider,
      currentKeyId: ring.currentId,
      previousKeyIds: [...ring.previous.keys()],
      configured: !!ring.current,
      fields: fieldRegistry.map((f) => `${f.table}.${f.fieldCol}`),
    };
  },
};

// ---------- 加密字段注册表：rotateSweep 扫表用 ----------

const fieldRegistry = []; // { table, idCol, fieldCol }

/** 注册需要参与 key 轮换 sweep 的加密字段 */
export function registerEncryptedField({ table, idCol = 'id', fieldCol }) {
  if (!table || !fieldCol) throw new Error('registerEncryptedField 需要 table/fieldCol');
  if (!fieldRegistry.some((f) => f.table === table && f.fieldCol === fieldCol)) {
    fieldRegistry.push({ table, idCol, fieldCol });
  }
}

/**
 * key 轮换 sweep：把仍用旧 kekId 的行重加密为当前 key。
 * @param {{ query: Function, run: Function }} dbh db 句柄（db()）
 */
export async function rotateSweep(dbh) {
  const ring = readKeyring();
  if (!ring.current) {
    throw Errors.serviceUnavailable('FIELD_ENCRYPTION_KEY 未配置，无法执行轮换 sweep',
      { code: 'FIELD_ENCRYPTION_UNCONFIGURED' });
  }
  const out = { scanned: 0, rotated: 0, fields: [], errors: [] };
  for (const f of fieldRegistry) {
    const rows = await dbh.query(
      `SELECT ${f.idCol} AS id, ${f.fieldCol} AS v FROM ${f.table} WHERE ${f.fieldCol} LIKE 'enc:v1:%'`);
    let fieldRotated = 0;
    for (const r of rows) {
      out.scanned++;
      try {
        const { envelope, rotated } = kms.rotate(r.v);
        if (rotated) {
          await dbh.run(`UPDATE ${f.table} SET ${f.fieldCol}=? WHERE ${f.idCol}=?`, [envelope, r.id]);
          out.rotated++;
          fieldRotated++;
        }
      } catch (e) {
        out.errors.push({ table: f.table, id: r.id, error: String(e?.message || e).slice(0, 160) });
      }
    }
    out.fields.push({ field: `${f.table}.${f.fieldCol}`, scanned: rows.length, rotated: fieldRotated });
  }
  return out;
}
