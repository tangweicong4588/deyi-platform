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
      },
    });
  }),

  http.get('*/v1/projects', () => {
    return HttpResponse.json({
      data: [{ id: 'prj_mock', name: 'Mock 项目', status: 'active' }],
    });
  }),
];
