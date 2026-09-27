import { http, HttpResponse } from 'msw';

/**
 * MSW handlers：离线开发/演示用 mock（VITE_USE_MOCK=true 时启用）。
 * 路径与真实后端对齐（F1 起）：POST /v1/auth/login、GET /v1/me、GET /v1/projects。
 * 响应包后端统一信封 { data } / 错误 { error: { code, message } }。
 */
const MOCK_TOKEN = 'mock_access_token';

export const handlers = [
  // 注：路径用 "*/v1/..." 通配形式——与裸相对路径 "/v1/..." 在浏览器 worker 中等价，
  // 且兼容 msw node 拦截管线（2.15 对裸相对路径的匹配有回归），便于 Node 侧验证。
  http.post('*/v1/auth/login', async ({ request }) => {
    const body = (await request.json()) as { tenant?: string; username?: string; password?: string; totpCode?: string };
    const tenant = (body.tenant ?? '').trim();
    const username = (body.username ?? '').trim();
    if (!tenant || !username || !body.password) {
      return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '租户、用户名和密码必填' } }, { status: 400 });
    }
    if (username === 'locked') {
      return HttpResponse.json({ error: { code: 'ACCOUNT_LOCKED', message: '账号已锁定，请 15 分钟后再试' } }, { status: 423 });
    }
    if (username === 'totp' && !body.totpCode) {
      return HttpResponse.json(
        { error: { code: 'TOTP_REQUIRED', message: '需要二次验证码', details: { code: 'TOTP_REQUIRED' } } },
        { status: 401 },
      );
    }
    return HttpResponse.json({
      data: {
        accessToken: MOCK_TOKEN,
        refreshToken: 'mock_refresh_token',
        expiresIn: 900,
        tokenType: 'Bearer',
        actor: { id: 'usr_mock', name: username, kind: 'user' },
        tenant: { id: 'ten_mock', slug: tenant },
      },
    });
  }),

  http.get('*/v1/me', ({ request }) => {
    const auth = request.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
      return HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '缺少认证' } }, { status: 401 });
    }
    return HttpResponse.json({
      data: {
        actor: { id: 'usr_mock', kind: 'user', name: 'Mock 用户' },
        tenant: { id: 'ten_mock', name: 'Mock 租户', slug: 'mock' },
        authKind: 'jwt',
        roles: [{ project_id: null, role: 'admin' }],
      },
    });
  }),

  http.get('*/v1/projects', () => {
    return HttpResponse.json({
      data: [{ id: 'prj_mock', name: 'Mock 项目', status: 'active' }],
    });
  }),

  // ---------- F2 租户管理面 mock ----------
  http.get('*/v1/admin/tenants/:tenantId/api-keys', () => {
    return HttpResponse.json({
      data: [
        {
          id: 'key_mock1', tenant_id: 'ten_mock', project_id: null, actor_id: 'usr_mock',
          name: '演示密钥', prefix: 'dy_mock', scopes: ['gateway.chat'], status: 'active',
          expires_at: null, last_used_at: Date.now() - 3600_000, created_at: Date.now() - 86400_000,
          ip_allowlist: [], note: 'mock 演示',
        },
      ],
    });
  }),

  http.post('*/v1/admin/tenants/:tenantId/api-keys', async ({ request }) => {
    const body = (await request.json()) as { name?: string; scopes?: string[] };
    return HttpResponse.json({
      data: {
        id: 'key_mock_new', tenant_id: 'ten_mock', project_id: null, actor_id: 'usr_mock',
        name: body.name ?? '新密钥', prefix: 'dy_new', scopes: body.scopes ?? [],
        status: 'active', expires_at: null, last_used_at: null, created_at: Date.now(),
        ip_allowlist: [], note: null, key: 'dy_mock_secret_只显示一次',
      },
    }, { status: 201 });
  }),

  http.patch('*/v1/admin/tenants/:tenantId/api-keys/:keyId', async ({ request, params }) => {
    const body = (await request.json()) as { ipAllowlist?: string[]; note?: string | null };
    return HttpResponse.json({
      data: {
        id: params.keyId, tenant_id: 'ten_mock', project_id: null, actor_id: 'usr_mock',
        name: '演示密钥', prefix: 'dy_mock', scopes: ['gateway.chat'], status: 'active',
        expires_at: null, last_used_at: null, created_at: Date.now(),
        ip_allowlist: body.ipAllowlist ?? [], note: body.note ?? null,
      },
    });
  }),

  http.post('*/v1/admin/tenants/:tenantId/api-keys/:keyId/rotate', async ({ request, params }) => {
    const body = (await request.json()) as { graceHours?: number };
    const gh = Math.min(720, Math.max(1, Number(body.graceHours) || 24));
    const graceUntil = Date.now() + gh * 3600_000;
    return HttpResponse.json({
      data: {
        oldKey: {
          id: params.keyId, name: '演示密钥', status: 'active', expires_at: graceUntil,
          rotated_to: 'key_mock_new', rotated_at: Date.now(),
        },
        newKey: {
          id: 'key_mock_new', tenant_id: 'ten_mock', project_id: null, actor_id: 'usr_mock',
          name: '演示密钥', prefix: 'dy_new', scopes: ['gateway.chat'], status: 'active',
          expires_at: null, last_used_at: null, created_at: Date.now(),
          ip_allowlist: [], note: null, secret: 'dy_mock_rotated_只显示一次',
        },
        graceUntil,
      },
    }, { status: 201 });
  }),

  http.delete('*/v1/admin/tenants/:tenantId/api-keys/:keyId', () => {
    return HttpResponse.json({ data: { revoked: true } });
  }),

  http.get('*/v1/tenants/:tenantId/billing/invoices', () => {
    return HttpResponse.json({
      data: [
        {
          id: 'inv_mock1', tenant_id: 'ten_mock', period_key: '2026-09', status: 'draft',
          currency: 'CNY', plan: 'professional', plan_fee_cents: 9900,
          usage_cost_cents: 120, usage_tokens: 15000, usage_calls: 320, total_cents: 10020,
          line_items: [
            { type: 'plan', label: '套餐 professional（月费）', amount_cents: 9900 },
            { type: 'usage', label: '模型调用（按量）', amount_cents: 120 },
          ],
          created_at: Date.now() - 86400_000, finalized_at: null, paid_at: null, voided_at: null,
        },
      ],
    });
  }),

  http.post('*/v1/tenants/:tenantId/billing/invoices', async ({ request }) => {
    const body = (await request.json()) as { period_key?: string };
    return HttpResponse.json({
      data: {
        id: 'inv_mock_new', tenant_id: 'ten_mock', period_key: body.period_key ?? '2026-09',
        status: 'draft', currency: 'CNY', plan: 'professional', plan_fee_cents: 9900,
        usage_cost_cents: 120, usage_tokens: 15000, usage_calls: 320, total_cents: 10020,
        line_items: [], created_at: Date.now(), finalized_at: null, paid_at: null, voided_at: null,
      },
    }, { status: 201 });
  }),

  http.get('*/v1/admin/tenants/:tenantId/budgets', () => {
    return HttpResponse.json({
      data: [
        {
          id: 'bud_mock1', tenant_id: 'ten_mock', project_id: null, period: 'monthly',
          cost_limit_cents: 50000, token_limit: 10000000,
          used_cost_cents: 120, used_tokens: 15000, source: 'plan',
          created_at: Date.now() - 86400_000, updated_at: Date.now() - 3600_000,
        },
      ],
    });
  }),

  http.put('*/v1/admin/tenants/:tenantId/budgets', async ({ request }) => {
    const body = (await request.json()) as { costLimitCents?: number | null; tokenLimit?: number | null };
    return HttpResponse.json({
      data: {
        id: 'bud_mock1', tenant_id: 'ten_mock', project_id: null, period: 'monthly',
        cost_limit_cents: body.costLimitCents ?? null, token_limit: body.tokenLimit ?? null,
        used_cost_cents: 120, used_tokens: 15000, source: 'manual',
        created_at: Date.now() - 86400_000, updated_at: Date.now(),
      },
    });
  }),

  http.get('*/v1/admin/tenants/:tenantId/usage', () => {
    return HttpResponse.json({
      data: [
        {
          id: 'call_mock1', model: 'qwen-max', tokens: 1200, cost_cents: 2,
          status: 'ok', created_at: Date.now() - 3600_000,
        },
      ],
    });
  }),
];
