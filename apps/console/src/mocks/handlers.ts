import { http, HttpResponse } from 'msw';

/**
 * MSW handlers：F0 mock 后端。只覆盖登录壳需要的最小面，
 * 响应包后端统一信封 { data } / 错误 { error: { code, message } }。
 */
export const handlers = [
  // 注：路径用 "*/v1/..." 通配形式——与裸相对路径 "/v1/..." 在浏览器 worker 中等价，
  // 且兼容 msw node 拦截管线（2.15 对裸相对路径的匹配有回归），便于 Node 侧验证。
  http.post('*/v1/auth/login', async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    const username = (body.username ?? '').trim();
    if (!username || !body.password) {
      return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '用户名和密码必填' } }, { status: 400 });
    }
    if (username === 'locked') {
      return HttpResponse.json({ error: { code: 'ACCOUNT_LOCKED', message: '账号已锁定，请 15 分钟后再试' } }, { status: 423 });
    }
    return HttpResponse.json({
      data: {
        token: 'mock-jwt-token',
        user: { id: 'usr_mock', name: username, email: `${username}@example.com` },
      },
    });
  }),

  http.post('*/v1/auth/me', ({ request }) => {
    const auth = request.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
      return HttpResponse.json({ error: { code: 'UNAUTHORIZED', message: '缺少认证' } }, { status: 401 });
    }
    return HttpResponse.json({
      data: {
        actor: { id: 'usr_mock', kind: 'user', name: 'Mock 用户' },
        tenant: { id: 'ten_mock', name: 'Mock 租户' },
      },
    });
  }),
];
