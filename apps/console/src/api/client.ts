/**
 * API client：类型化 fetch 封装。
 * - base 取 VITE_API_BASE_URL（联调时指向控制面，如 http://127.0.0.1:8080）
 * - 自动注入 Authorization: Bearer；透传 x-trace-id 便于链路追踪
 * - 后端信封 { data } 自动解包；错误抛 ApiError（status/code/message）
 */
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Options {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  /** 二进制直传：body 不做 JSON 序列化，content-type 由调用方 headers 指定 */
  rawBody?: boolean;
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !opts.rawBody) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : (opts.rawBody ? (opts.body as BodyInit) : JSON.stringify(opts.body)),
  });

  let json: any = null;
  try { json = await res.json(); } catch { /* 非 JSON 按原文处理 */ }

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `请求失败（${res.status}）`, err.details);
  }
  // 防御：200 但 body 不是对象（例如 mock 未覆盖的路径被 dev server 回退到 index.html，
  // res.json() 解析失败 json=null）——直接抛错，避免调用方拿到 null 后渲染白屏。
  if (json === null || typeof json !== 'object') {
    throw new ApiError(res.status, 'EMPTY_RESPONSE', '服务端返回了空响应');
  }
  // 后端统一信封 { data }；兼容直接返回体的 mock
  return ('data' in json ? json.data : json) as T;
}

export const get = <T>(path: string, opts?: Options) => api<T>(path, { ...opts, method: 'GET' });
export const post = <T>(path: string, body?: unknown, opts?: Options) => api<T>(path, { ...opts, method: 'POST', body });
export const del = <T>(path: string, opts?: Options) => api<T>(path, { ...opts, method: 'DELETE' });
