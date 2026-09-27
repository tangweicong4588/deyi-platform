/**
 * modules/identity/totp.mjs —— V2.10：TOTP 二次验证（RFC 4226/6238）。
 * 纯 node:crypto 实现，无外部依赖；默认 SHA1/30s/6 位（Google Authenticator 兼容）。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function b32decode(s) {
  const clean = String(s).replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('非法 base32');
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

/** 生成 20 字节随机 secret（base32） */
export function generateTotpSecret() {
  return b32encode(randomBytes(20));
}

function hotp(secret, counter, digits = 6) {
  const key = b32decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret, atMs = Date.now(), stepS = 30, digits = 6) {
  return hotp(secret, Math.floor(atMs / 1000 / stepS), digits);
}

/** 校验（±window 个时间步容忍时钟偏差）；恒定时间比较防侧信道 */
export function verifyTotp(secret, code, { window = 1, atMs = Date.now(), stepS = 30, digits = 6 } = {}) {
  const want = String(code).replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(want)) return false;
  const cur = Math.floor(atMs / 1000 / stepS);
  for (let c = cur - window; c <= cur + window; c++) {
    const cand = hotp(secret, c, digits);
    const a = Buffer.from(cand), b = Buffer.from(want);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function otpauthUrl(secret, { issuer = 'Deyi', account = 'user' } = {}) {
  const q = new URLSearchParams({ secret, issuer });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${q}`;
}
