/**
 * kernel/errors.mjs —— 平台错误：带 code + HTTP 状态码，全局统一转 JSON。
 */
export class PlatformError extends Error {
  constructor(code, message, { status = 500, details = undefined } = {}) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (msg, details) => new PlatformError('BAD_REQUEST', msg, { status: 400, details }),
  unauthorized: (msg = '未认证') => new PlatformError('UNAUTHORIZED', msg, { status: 401 }),
  forbidden: (msg = '无权限', details) => new PlatformError('FORBIDDEN', msg, { status: 403, details }),
  notFound: (msg = '不存在') => new PlatformError('NOT_FOUND', msg, { status: 404 }),
  conflict: (msg, details) => new PlatformError('CONFLICT', msg, { status: 409, details }),
  gone: (msg) => new PlatformError('GONE', msg, { status: 410 }),
  locked: (msg = '已锁定') => new PlatformError('LOCKED', msg, { status: 423 }),
  policyDenied: (reason, details) => new PlatformError('POLICY_DENIED', `策略拒绝：${reason}`, { status: 403, details }),
  budgetExceeded: (details) => new PlatformError('BUDGET_EXCEEDED', '预算已耗尽', { status: 402, details }),
  rateLimited: (retryAfterMs, details) =>
    new PlatformError('RATE_LIMITED', '请求过于频繁，请稍后重试', {
      status: 429, details: { code: 'RATE_LIMITED', retry_after_ms: retryAfterMs, ...(details || {}) },
    }),
  approvalRequired: (approvalId) =>
    new PlatformError('APPROVAL_REQUIRED', '该操作需要审批', { status: 403, details: { approvalId } }),
  upstream: (msg, details) => new PlatformError('UPSTREAM_ERROR', msg, { status: 502, details }),
  serviceUnavailable: (msg, details) => new PlatformError('SERVICE_UNAVAILABLE', msg, { status: 503, details }),
  internal: (msg = '内部错误', details) => new PlatformError('INTERNAL', msg, { status: 500, details }),
};

/** 把错误转成对外 JSON（500 不泄露内部细节） */
export function toErrorJson(err) {
  if (err instanceof PlatformError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined && err.status < 500) body.error.details = err.details;
    return { status: err.status, body };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: '内部错误' } } };
}
