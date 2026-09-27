/**
 * modules/identity/ipallow.mjs —— V2.14：API Key 级 IP 白名单。
 *
 * - 条目：IPv4 CIDR（如 10.0.0.0/24）/ IPv4 单 IP / IPv6 单 IP（精确匹配）。
 *   IPv6 CIDR 暂不支持（normalize 时明确拒绝，不静默降级）。
 * - 空名单 = 不限制（历史 key 向后兼容）。
 * - 来源 IP 解析的信任边界见 resolveClientIp：只有 TRUST_PROXY=true 才采信
 *   x-forwarded-for；代理不可信时伪造 XFF 可绕过白名单，故默认关闭，
 *   这是部署配置责任（deploy/README.md 有说明）。
 */
import { isIPv4, isIPv6 } from 'node:net';
import { Errors } from '../../kernel/errors.mjs';

export const MAX_ALLOWLIST_ENTRIES = 32;
export const MAX_NOTE_LENGTH = 500;

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((((p[0] * 256 + p[1]) * 256) + p[2]) * 256 + p[3]) >>> 0;
}

/** 归一化单条目为 canonical 形式；非法抛 400 */
export function normalizeAllowlistEntry(entry) {
  const s = String(entry ?? '').trim();
  if (!s) throw Errors.badRequest('IP 白名单条目不能为空', { code: 'INVALID_ALLOWLIST' });
  const slash = s.indexOf('/');
  if (slash >= 0) {
    const ip = s.slice(0, slash);
    const bits = Number(s.slice(slash + 1));
    if (!isIPv4(ip)) {
      throw Errors.badRequest(`白名单暂仅支持 IPv4 CIDR（IPv6 仅支持单 IP）：${s}`, { code: 'INVALID_ALLOWLIST' });
    }
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw Errors.badRequest(`非法 CIDR 前缀长度：${s}`, { code: 'INVALID_ALLOWLIST' });
    }
    return `${ip}/${bits}`;
  }
  if (isIPv4(s)) return `${s}/32`;
  if (isIPv6(s)) return s; // IPv6 单 IP：精确匹配
  throw Errors.badRequest(`非法 IP/CIDR：${s}`, { code: 'INVALID_ALLOWLIST' });
}

/** 校验整个名单，返回去重后的 canonical 数组；undefined/null → []（不限制） */
export function assertValidAllowlist(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw Errors.badRequest('ipAllowlist 必须为数组', { code: 'INVALID_ALLOWLIST' });
  if (list.length > MAX_ALLOWLIST_ENTRIES) {
    throw Errors.badRequest(`IP 白名单最多 ${MAX_ALLOWLIST_ENTRIES} 条`, { code: 'INVALID_ALLOWLIST' });
  }
  return [...new Set(list.map(normalizeAllowlistEntry))];
}

export function assertValidNote(note) {
  if (note === undefined || note === null) return null;
  const s = String(note);
  if (s.length > MAX_NOTE_LENGTH) throw Errors.badRequest(`note 最多 ${MAX_NOTE_LENGTH} 字符`, { code: 'INVALID_NOTE' });
  return s;
}

/**
 * 解析 DB 里存的 JSON。返回 { ok, list }；坏数据 ok=false，
 * 调用方必须 fail-closed（拒绝该 key），绝不能静默按"不限制"处理。
 */
export function parseAllowlistJson(json) {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return { ok: false, list: [] };
    return { ok: true, list: v.filter((x) => typeof x === 'string') };
  } catch {
    return { ok: false, list: [] };
  }
}

function entryMatches(entry, ip) {
  if (entry.includes('/')) {
    const [net, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xFFFFFFFF : ((0xFFFFFFFF << (32 - bits)) >>> 0);
    return ((ipv4ToInt(net) & mask) >>> 0) === ((ipv4ToInt(ip) & mask) >>> 0);
  }
  return entry === ip; // IPv6 单 IP 精确匹配
}

/** IPv4-mapped IPv6（::ffff:1.2.3.4）还原为 IPv4 */
export function normalizeIp(ip) {
  if (ip === undefined || ip === null) return null;
  let s = String(ip).trim();
  if (!s) return null;
  if (s.startsWith('::ffff:') && isIPv4(s.slice(7))) s = s.slice(7);
  return s;
}

/** 空名单 = 不限制；取不到来源 IP 时拒绝（fail-closed） */
export function ipAllowed(ip, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const norm = normalizeIp(ip);
  if (!norm) return false;
  return allowlist.some((e) => {
    try { return entryMatches(String(e), norm); }
    catch { return false; }
  });
}

/**
 * 解析客户端来源 IP。
 * @param trustProxy 是否信任反向代理（对应 TRUST_PROXY=true，即平台部署在可信
 *   反向代理之后，代理负责清洗/追加 XFF）。为 false 时 XFF 完全忽略，
 *   一律用直连 socket 地址——伪造 XFF 无法绕过。
 */
export function resolveClientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
      return normalizeIp(fwd.split(',')[0].trim());
    }
  }
  return normalizeIp(req.socket?.remoteAddress);
}
