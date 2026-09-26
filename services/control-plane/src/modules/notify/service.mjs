/**
 * modules/notify/service.mjs —— V2.1-C：通知通道。
 *
 * 设计：
 * - 通道抽象：首批实现 webhook（真实 HTTP POST，可对接飞书/钉钉/企微/Slack 的
 *   自定义机器人 webhook）；email/sms/im 以 kind 注册位保留，未实现前建通道直接 400。
 * - 密钥铁律：secret_ref 只存 `env:VAR` / `vault:...` 引用，密钥材料发送时即时解析，
 *   永不落库、永不进投递日志。`vault:` 目前抛 NOT_IMPLEMENTED（如实标注）。
 * - SSRF 防护：target 必须 http(s)；字面量私网/回环/链路本地 IP 默认拒绝，
 *   主机名做 DNS 解析后验 IP；NOTIFY_ALLOW_PRIVATE_TARGETS=true 才放行（测试/内网 webhook 用）。
 * - 投递账本 notify_deliveries：queued→sent/failed 全轨迹；无通道时记 skipped（显式，
 *   不静默丢弃）。当前为请求内同步投递（超时 NOTIFY_TIMEOUT_MS）；生产建议转异步
 *   outbox  drain + 退避重试——此处如实标注，未实现。
 * - 载荷脱敏：发送前递归剥离疑似密钥字段。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db } from '../../db/index.mjs';
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx } from '../../kernel/context.mjs';
import { newId, assertId, nowMs } from '../../kernel/ids.mjs';
import { tryAudit } from '../evidence/audit.mjs';

export const CHANNEL_KINDS = new Set(['webhook']); // email/sms/im 为注册位，实现后开放
export const CHANNEL_STATUSES = new Set(['active', 'disabled']);
export const INTENTS = new Set([
  'reconciliation.escalated', 'notify.test',
]);

const SECRET_KEY_RE = /secret|passwd|password|token|api[_-]?key|private[_-]?key|sk[_-]?live/i;

// ---------- 密钥引用解析 ----------
export function resolveSecret(secretRef) {
  if (!secretRef) return null;
  if (secretRef.startsWith('env:')) {
    const name = secretRef.slice(4);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw Errors.badRequest(`非法 secret_ref: ${secretRef}`);
    const v = process.env[name];
    if (!v) throw Errors.badRequest(`secret_ref 指向的环境变量未设置: ${name}`, { code: 'SECRET_UNRESOLVED' });
    return v;
  }
  if (secretRef.startsWith('vault:')) {
    // 如实标注：vault 后端未实现，不静默跳过签名
    throw Errors.badRequest('vault 密钥后端尚未实现，secret_ref 暂只支持 env:', { code: 'NOT_IMPLEMENTED' });
  }
  throw Errors.badRequest(`非法 secret_ref（仅支持 env:/vault:）: ${secretRef.slice(0, 40)}`);
}

// ---------- SSRF 防护 ----------
function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 解析异常按私网处理（fail-closed）
  return p[0] === 127 || p[0] === 10 || p[0] === 169 && p[1] === 254 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    p[0] === 0;
}

/** 校验 webhook 目标：协议/私网/DNS 二次解析。返回规范化 URL，非法抛 400。 */
export async function assertSafeTarget(target) {
  let u;
  try { u = new URL(String(target)); } catch { throw Errors.badRequest('target 不是合法 URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Errors.badRequest('webhook target 仅支持 http(s)');
  if (u.username || u.password) throw Errors.badRequest('webhook target 不得携带用户信息');
  const allowPrivate = config.NOTIFY_ALLOW_PRIVATE_TARGETS === 'true';
  const host = u.hostname;
  const check = (ip, where) => {
    if (isPrivateIp(ip) && !allowPrivate) {
      throw Errors.badRequest(`webhook target 指向内网/回环地址被拒绝（${where}）`, { code: 'SSRF_BLOCKED' });
    }
  };
  if (isIP(host)) {
    check(host, '字面量 IP');
  } else {
    // 主机名：DNS 解析后验 IP（防 DNS rebinding 的基础手段）
    let addrs;
    try { addrs = await lookup(host, { all: true }); }
    catch { throw Errors.badRequest(`webhook target 主机名无法解析: ${host}`, { code: 'DNS_UNRESOLVED' }); }
    for (const a of addrs) check(a.address, `DNS 解析 ${a.address}`);
  }
  u.hash = '';
  return u.toString();
}

// ---------- 载荷脱敏 ----------
export function sanitizePayload(obj) {
  if (Array.isArray(obj)) return obj.map(sanitizePayload);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitizePayload(v);
    }
    return out;
  }
  return obj;
}

// ---------- 通道 CRUD ----------
export async function createChannel(tenantId, { kind, name, target, secretRef = null }) {
  assertId('ten', tenantId);
  if (!CHANNEL_KINDS.has(kind)) {
    throw Errors.badRequest(`通知通道 kind 尚未实现: ${kind}（当前可用: ${[...CHANNEL_KINDS].join(',')}）`,
      { code: 'CHANNEL_KIND_UNSUPPORTED' });
  }
  if (!name || !String(name).trim()) throw Errors.badRequest('name 必填');
  const safeTarget = await assertSafeTarget(target);
  if (secretRef) resolveSecret(secretRef); // 建通道时即验引用有效性（fail-fast，不存明文）
  const row = {
    id: newId('nch'), tenant_id: tenantId, kind,
    name: String(name).trim(), target: safeTarget, secret_ref: secretRef,
    status: 'active', created_at: nowMs(), updated_at: nowMs(),
  };
  try {
    await db().query(
      `INSERT INTO notify_channels(id,tenant_id,kind,name,target,secret_ref,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.id, row.tenant_id, row.kind, row.name, row.target, row.secret_ref, row.status, row.created_at, row.updated_at]);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict(`通知通道名已存在: ${row.name}`);
    throw e;
  }
  const { secret_ref: _s, ...safe } = row;
  return { ...safe, secret_ref: row.secret_ref ? '[ref]' : null }; // 引用只回显存在性
}

/** 通道列表：secret_ref 永不回显，只回 has_secret 存在性。 */
export async function listChannels(tenantId) {
  assertId('ten', tenantId);
  const rows = await db().query(
    'SELECT id,tenant_id,kind,name,target,secret_ref,status,created_at,updated_at FROM notify_channels WHERE tenant_id=? ORDER BY created_at',
    [tenantId]);
  return rows.map((r) => {
    const { secret_ref, ...rest } = r;
    return { ...rest, has_secret: !!secret_ref };
  });
}

async function getChannelRow(tenantId, channelId) {
  assertId('ten', tenantId); assertId('nch', channelId);
  const rows = await db().query('SELECT * FROM notify_channels WHERE id=? AND tenant_id=?', [channelId, tenantId]);
  return rows[0] || null;
}

export async function updateChannel(tenantId, channelId, patch = {}) {
  const ch = await getChannelRow(tenantId, channelId);
  if (!ch) throw Errors.notFound('通知通道不存在');
  const sets = [], args = [];
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) throw Errors.badRequest('name 不能为空');
    sets.push('name=?'); args.push(String(patch.name).trim());
  }
  if (patch.target !== undefined) { sets.push('target=?'); args.push(await assertSafeTarget(patch.target)); }
  if (patch.secretRef !== undefined) {
    if (patch.secretRef) resolveSecret(patch.secretRef);
    sets.push('secret_ref=?'); args.push(patch.secretRef || null);
  }
  if (patch.status !== undefined) {
    if (!CHANNEL_STATUSES.has(patch.status)) throw Errors.badRequest(`非法状态: ${patch.status}`);
    sets.push('status=?'); args.push(patch.status);
  }
  if (!sets.length) return listChannels(tenantId).then((l) => l.find((x) => x.id === channelId));
  sets.push('updated_at=?'); args.push(nowMs(), channelId);
  try {
    await db().query(`UPDATE notify_channels SET ${sets.join(',')} WHERE id=?`, args);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw Errors.conflict('通知通道名已存在');
    throw e;
  }
  return (await listChannels(tenantId)).find((x) => x.id === channelId);
}

export async function deleteChannel(tenantId, channelId) {
  const r = await db().run('DELETE FROM notify_channels WHERE id=? AND tenant_id=?', [channelId, tenantId]);
  if (!r.changes) throw Errors.notFound('通知通道不存在');
}

// ---------- 投递 ----------
async function insertDelivery({ tenantId, channelId, intent, payload, status, lastError = null }) {
  const row = {
    id: newId('ndl'), tenant_id: tenantId, channel_id: channelId, intent,
    payload: JSON.stringify(payload), status, attempts: 0,
    last_error: lastError, created_at: nowMs(), updated_at: nowMs(),
  };
  await db().query(
    `INSERT INTO notify_deliveries(id,tenant_id,channel_id,intent,payload,status,attempts,last_error,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.tenant_id, row.channel_id, row.intent, row.payload, row.status,
     row.attempts, row.last_error, row.created_at, row.updated_at]);
  return row.id;
}

async function markDelivery(id, status, lastError) {
  await db().query('UPDATE notify_deliveries SET status=?, attempts=attempts+1, last_error=?, updated_at=? WHERE id=?',
    [status, lastError, nowMs(), id]);
}

function signPayload(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function postWebhook(channel, deliveryId, intent, payload) {
  const secret = resolveSecret(channel.secret_ref); // 发送时即时解析
  const body = JSON.stringify({ intent, delivery_id: deliveryId, tenant_id: channel.tenant_id, ...payload });
  const headers = {
    'content-type': 'application/json',
    'x-deyi-intent': intent,
    'x-deyi-delivery-id': deliveryId,
  };
  if (secret) headers['x-deyi-signature'] = signPayload(secret, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('通知投递超时')), Number(config.NOTIFY_TIMEOUT_MS) || 8000);
  try {
    const r = await fetch(channel.target, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!r.ok) throw new Error(`webhook 返回 ${r.status}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发送通知。返回 { delivered, channelCount, results }。
 * 无可用通道 → 记 skipped（显式不静默）+ 审计留痕。
 */
export async function sendNotification({ tenantId, intent, title, body, extra = {}, channelId = null }) {
  assertId('ten', tenantId);
  if (!INTENTS.has(intent)) throw Errors.badRequest(`未知通知 intent: ${intent}`);
  const c = ctx();
  const actorId = c.actorId || null;
  const payload = sanitizePayload({
    title: String(title || '').slice(0, 200),
    body: String(body || '').slice(0, 2000),
    trace_id: c.traceId || undefined,
    ...extra,
  });

  let channels = await db().query(
    "SELECT * FROM notify_channels WHERE tenant_id=? AND status='active' ORDER BY created_at", [tenantId]);
  if (channelId) {
    assertId('nch', channelId);
    channels = channels.filter((x) => x.id === channelId);
    if (!channels.length) throw Errors.notFound('通知通道不存在或已停用');
  }
  if (!channels.length) {
    const id = await insertDelivery({ tenantId, channelId: null, intent, payload, status: 'skipped', lastError: 'no-channel-configured' });
    await tryAudit({
      tenantId, actorId, traceId: c.traceId,
      action: 'notify.skipped', resourceKind: 'notify_delivery', resourceId: id,
      payload: { intent, reason: 'no-channel-configured', title: payload.title },
    });
    return { delivered: false, reason: 'no-channel-configured', deliveryIds: [id] };
  }

  const results = [];
  const deliveryIds = [];
  for (const ch of channels) {
    const deliveryId = await insertDelivery({ tenantId, channelId: ch.id, intent, payload, status: 'queued' });
    deliveryIds.push(deliveryId);
    let res;
    try {
      res = ch.kind === 'webhook'
        ? await postWebhook(ch, deliveryId, intent, payload)
        : { ok: false, error: `通道 kind 未实现: ${ch.kind}` };
    } catch (e) {
      res = { ok: false, error: String(e.message || e).slice(0, 500) };
    }
    await markDelivery(deliveryId, res.ok ? 'sent' : 'failed', res.ok ? null : res.error);
    await tryAudit({
      tenantId, actorId, traceId: c.traceId,
      action: res.ok ? 'notify.sent' : 'notify.failed',
      resourceKind: 'notify_delivery', resourceId: deliveryId,
      payload: { intent, channel: ch.name, kind: ch.kind, error: res.ok ? undefined : res.error },
    });
    results.push({ channel: ch.name, ok: res.ok, error: res.ok ? undefined : res.error, deliveryId });
  }
  return { delivered: results.some((r) => r.ok), channelCount: channels.length, results, deliveryIds };
}

/** 供业务域调用的便捷封装：对账升级通知 */
export async function notifyReconEscalated({ tenantId, projectId, recon, assignee }) {
  return sendNotification({
    tenantId,
    intent: 'reconciliation.escalated',
    title: `对账项已升级：${recon.id}`,
    body: `对账项 ${recon.id} 已升级，指派给 ${assignee}，请及时处理。`,
    extra: { reconciliation_id: recon.id, project_id: projectId, assignee, source: recon.source },
  });
}

export async function listDeliveries(tenantId, { limit = 50 } = {}) {
  assertId('ten', tenantId);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db().query(
    `SELECT d.id,d.channel_id,d.intent,d.status,d.attempts,d.last_error,d.created_at,c.name AS channel_name
     FROM notify_deliveries d LEFT JOIN notify_channels c ON d.channel_id=c.id
     WHERE d.tenant_id=? ORDER BY d.created_at DESC LIMIT ${n}`, [tenantId]);
  return rows;
}

// 测试辅助：验签（给单测用，不暴露密钥）
export function verifySignature(secret, body, sig) {
  const expected = signPayload(secret, body);
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch { return false; }
}
