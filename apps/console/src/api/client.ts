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
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  let json: any = null;
  try { json = await res.json(); } catch { /* 非 JSON 按原文处理 */ }

  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `请求失败（${res.status}）`, err.details);
  }
  // 后端统一信封 { data }；兼容直接返回体的 mock
  return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
}

export const get = <T>(path: string, opts?: Options) => api<T>(path, { ...opts, method: 'GET' });
export const post = <T>(path: string, body?: unknown, opts?: Options) => api<T>(path, { ...opts, method: 'POST', body });
