/**
 * modules/execution/mcp.mjs —— MCP 网关适配（薄）。
 *
 * MVP 范围：
 * - MCP over HTTP 的最小 JSON-RPC 2.0 client：tools/list（发现）、tools/call（调用）。
 * - kind=http：通用 webhook（POST {action, args}）。
 * - kind=builtin：进程内测试工具（echo/fail/delay，见 service.mjs）。
 * - stdio 传输暂不支持：endpoint 非 http(s) 直接拒绝（明确标注，不静默）。
 *
 * 密钥铁律：
 * - 凭证只以 vault_ref 引用形式出现在 tools.config / tool_credentials；
 *   resolveSecret() 在调用瞬间从环境变量解析，绝不落库、绝不进日志/错误。
 */
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';

/** 凭证解析：vault_ref 即环境变量名（如 TOOL_X_API_KEY）。生产应由 Vault/K8s secret 挂载为环境变量。 */
export function resolveSecret(vaultRef) {
  if (!vaultRef || typeof vaultRef !== 'string') throw Errors.badRequest('vault_ref 非法');
  const v = process.env[vaultRef];
  if (!v) {
    // 注意：错误信息里不带任何密钥相关值，只说"未配置"
    throw Errors.upstream(`工具凭证未配置（vault_ref=${vaultRef} 无法解析）`);
  }
  return v;
}

/** endpoint 必须是 http(s)；stdio 等暂不支持，明确拒绝 */
export function assertHttpEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint)) {
    throw Errors.badRequest('MCP endpoint 必须为 http(s) 地址（stdio 传输暂不支持）');
  }
}

/** 从工具配置拼装鉴权头：config.auth = { type: 'bearer'|'header'|'none', vault_ref, header_name? } */
export function authHeadersFor(tool) {
  let cfg = {};
  try { cfg = JSON.parse(tool.config || '{}'); } catch { /* 忽略脏配置 */ }
  const auth = cfg.auth || { type: 'none' };
  if (auth.type === 'none' || !auth.type) return {};
  if (!auth.vault_ref) throw Errors.badRequest('auth 配置缺少 vault_ref（凭证禁止明文）');
  const secret = resolveSecret(auth.vault_ref);
  if (auth.type === 'bearer') return { authorization: `Bearer ${secret}` };
  if (auth.type === 'header') {
    if (!auth.header_name) throw Errors.badRequest('header 鉴权缺少 header_name');
    return { [auth.header_name.toLowerCase()]: secret };
  }
  throw Errors.badRequest(`不支持的 auth type: ${auth.type}`);
}

let rpcSeq = 0;

/** JSON-RPC 2.0 调用（MCP over HTTP） */
export async function mcpRpc(endpoint, method, params, { headers = {}, timeoutMs = 30000 } = {}) {
  assertHttpEndpoint(endpoint);
  const res = await fetch(endpoint.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: `deyi-${++rpcSeq}`, method, params: params || {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw Errors.upstream(`MCP 传输失败: ${res.status}`, { status: res.status });
  }
  let json;
  const ctype = res.headers.get('content-type') || '';
  if (/text\/event-stream/i.test(ctype)) {
    // SSE（MCP Streamable HTTP 可能返回事件流）：解析 data: 行，取最后一个完整 JSON-RPC 响应
    json = await parseSseJsonRpc(res);
  } else {
    try {
      json = await res.json();
    } catch {
      throw Errors.upstream('MCP 返回非 JSON');
    }
  }
  if (json.error) {
    throw Errors.upstream(`MCP 工具错误: ${json.error.message || json.error.code}`, {
      code: json.error.code,
    });
  }
  return json.result;
}

/** 最小 SSE 解析：收集 data: 行，返回最后一个能解析为 JSON-RPC 响应的对象 */
async function parseSseJsonRpc(res) {
  const text = await res.text();
  const datas = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) datas.push(t.slice(5).trim());
  }
  for (let i = datas.length - 1; i >= 0; i--) {
    if (datas[i] === '[DONE]') continue;
    try {
      const j = JSON.parse(datas[i]);
      if (j && (j.result !== undefined || j.error)) return j;
    } catch { /* 不是完整 JSON 就继续往前找 */ }
  }
  throw Errors.upstream('MCP SSE 响应中没有可解析的 JSON-RPC 结果');
}

/** 发现工具（注册时可选校验连通性） */
export async function discoverTools(endpoint, opts = {}) {
  const result = await mcpRpc(endpoint, 'tools/list', {}, opts);
  return result?.tools || [];
}

/** 调用 MCP 工具 */
export async function callMcpTool(endpoint, name, args, opts = {}) {
  const result = await mcpRpc(endpoint, 'tools/call', { name, arguments: args || {} }, opts);
  return result;
}

/** 通用 http 工具：POST { action, args } */
export async function callHttpTool(endpoint, action, args, { headers = {}, timeoutMs = 30000 } = {}) {
  assertHttpEndpoint(endpoint);
  const res = await fetch(endpoint.replace(/\/$/, ''), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ action, args: args || {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw Errors.upstream(`HTTP 工具调用失败: ${res.status}`, { status: res.status });
  }
  try {
    return await res.json();
  } catch {
    throw Errors.upstream('HTTP 工具返回非 JSON');
  }
}

/** 注册时连通性校验（失败只告警，不阻断注册——工具可能稍后上线） */
export async function probeEndpoint(kind, endpoint, opts = {}) {
  try {
    if (kind === 'mcp') {
      const tools = await discoverTools(endpoint, opts);
      return { ok: true, tools: tools.length };
    }
    if (kind === 'http') {
      const res = await fetch(endpoint.replace(/\/$/, ''), {
        method: 'HEAD', signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      return { ok: !!res, status: res?.status ?? null };
    }
    return { ok: true };
  } catch (e) {
    logger.warn('tool endpoint probe failed', { kind, err: e.message });
    return { ok: false, err: e.message };
  }
}
