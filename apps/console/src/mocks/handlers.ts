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

  // ---------- F1 业务面 mock（内存数据，演示可写） ----------
  ...f1Handlers(),
  // ---------- F3 软件生产 mock（内存数据，演示可写） ----------
  ...f3Handlers(),
];

// ---- F1 mock 数据与 handlers：任务 / 知识库 / 记忆 ----
// 注意：module 级内存数据，dev server 热重载时重置；仅供离线演示。
const now = () => Date.now();
let mockTaskSeq = 3;
const mockTasks: Array<Record<string, unknown>> = [
  {
    id: 'tsk_mock1', kind: 'ticket', title: '演示工单：对接客户 SSO', description: '演示数据',
    status: 'in_progress', priority: 'high', assignee_id: 'usr_mock', escalated: 0,
    created_by: 'usr_mock', created_at: now() - 7200_000, updated_at: now() - 3600_000, closed_at: null,
  },
  {
    id: 'tsk_mock2', kind: 'approval', title: '演示审批单：发布 v0.2.0', description: '演示数据',
    status: 'pending', priority: 'normal', assignee_id: null, escalated: 0,
    created_by: 'usr_mock', created_at: now() - 3600_000, updated_at: now() - 3600_000, closed_at: null,
  },
];
const mockTransitions: Record<string, Array<Record<string, unknown>>> = {
  tsk_mock1: [
    { id: 'tr_mock1', from_status: 'open', to_status: 'in_progress', actor_id: 'usr_mock', note: null, created_at: now() - 3600_000 },
  ],
  tsk_mock2: [],
};
const findTask = (id: string) => mockTasks.find((t) => t.id === id);

let mockDocSeq = 2;
const mockDocs: Array<{ id: string; title: string; content: string; mime: string; status: string; version: number; created_at: number }> = [
  { id: 'doc_mock1', title: '演示文档：平台介绍', content: '得逸智行企业级 AI 交付与执行平台，演示用文档。', mime: 'text/markdown', status: 'ready', version: 1, created_at: now() - 86400_000 },
];

let mockMemSeq = 2;
const mockMems: Array<Record<string, unknown>> = [
  { id: 'mem_mock1', kind: 'semantic', visibility: 'private', content: '演示记忆：客户偏好简洁汇报', created_at: now() - 86400_000 },
];

function f1Handlers() {
  return [
    // 业务任务
    http.get('*/v1/projects/:projectId/tasks', () => {
      return HttpResponse.json({ data: mockTasks });
    }),
    http.post('*/v1/projects/:projectId/tasks', async ({ request }) => {
      const body = (await request.json()) as { kind?: string; title?: string; description?: string; priority?: string };
      if (!body.title?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '标题必填' } }, { status: 400 });
      }
      const task: Record<string, unknown> = {
        id: `tsk_mock${mockTaskSeq++}`, kind: body.kind ?? 'ticket', title: body.title.trim(),
        description: body.description?.trim() ?? '', status: 'open', priority: body.priority ?? 'normal',
        assignee_id: null, escalated: 0, created_by: 'usr_mock',
        created_at: now(), updated_at: now(), closed_at: null,
      };
      mockTasks.unshift(task);
      mockTransitions[task.id as string] = [];
      return HttpResponse.json({ data: task }, { status: 201 });
    }),
    http.get('*/v1/projects/:projectId/tasks/:taskId', ({ params }) => {
      const task = findTask(params.taskId as string);
      if (!task) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404 });
      }
      return HttpResponse.json({ data: { task, transitions: mockTransitions[task.id as string] ?? [] } });
    }),
    http.post('*/v1/projects/:projectId/tasks/:taskId/transition', async ({ request, params }) => {
      const task = findTask(params.taskId as string);
      if (!task) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404 });
      }
      const body = (await request.json()) as { to?: string; note?: string | null };
      const from = task.status as string;
      task.status = body.to ?? from;
      task.updated_at = now();
      (mockTransitions[task.id as string] ??= []).push({
        id: `tr_mock${now()}`, from_status: from, to_status: task.status,
        actor_id: 'usr_mock', note: body.note ?? null, created_at: now(),
      });
      return HttpResponse.json({ data: task });
    }),
    http.post('*/v1/projects/:projectId/tasks/:taskId/decide', async ({ request, params }) => {
      const task = findTask(params.taskId as string);
      if (!task) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, { status: 404 });
      }
      const body = (await request.json()) as { approved?: boolean; note?: string | null };
      const from = task.status as string;
      // mock 演示：跳过 SoD（真实后端会校验发起人不能自批）
      task.status = body.approved ? 'resolved' : 'cancelled';
      task.updated_at = now();
      if (task.status === 'cancelled') task.closed_at = now();
      (mockTransitions[task.id as string] ??= []).push({
        id: `tr_mock${now()}`, from_status: from, to_status: task.status,
        actor_id: 'usr_mock', note: body.note ?? null, created_at: now(),
      });
      return HttpResponse.json({ data: task });
    }),

    // 知识库
    http.get('*/v1/projects/:projectId/knowledge/documents', () => {
      return HttpResponse.json({
        data: mockDocs.map(({ content: _c, ...d }) => d),
      });
    }),
    http.post('*/v1/projects/:projectId/knowledge/documents', async ({ request }) => {
      const body = (await request.json()) as { title?: string; content?: string; mime?: string };
      if (!body.title?.trim() || !body.content?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '标题和内容必填' } }, { status: 400 });
      }
      const doc = {
        id: `doc_mock${mockDocSeq++}`, title: body.title.trim(), content: body.content,
        mime: body.mime ?? 'text/markdown', status: 'ready', version: 1, created_at: now(),
      };
      mockDocs.unshift(doc);
      const { content: _c, ...rest } = doc;
      return HttpResponse.json({ data: { document: { id: doc.id }, ...rest } }, { status: 201 });
    }),
    http.post('*/v1/projects/:projectId/knowledge/search', async ({ request }) => {
      const body = (await request.json()) as { query?: string; limit?: number };
      const q = (body.query ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 5));
      const hits = mockDocs
        .filter((d) => !q || d.title.includes(q) || d.content.includes(q))
        .slice(0, limit)
        .map((d, i) => ({
          docId: d.id, title: d.title, score: 1 - i * 0.1,
          snippet: d.content.slice(0, 120),
        }));
      return HttpResponse.json({ data: hits });
    }),

    // 记忆
    http.post('*/v1/tenants/:tenantId/memory', async ({ request }) => {
      const body = (await request.json()) as { content?: string; kind?: string; visibility?: string };
      if (!body.content?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '内容必填' } }, { status: 400 });
      }
      const item: Record<string, unknown> = {
        id: `mem_mock${mockMemSeq++}`, kind: body.kind ?? 'episodic',
        visibility: body.visibility ?? 'private', content: body.content.trim(), created_at: now(),
      };
      mockMems.unshift(item);
      return HttpResponse.json({ data: item }, { status: 201 });
    }),
    http.get('*/v1/tenants/:tenantId/memory/recall', ({ request }) => {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const items = mockMems
        .filter((m) => !q || q === '*' || String(m.content).includes(q))
        .slice(0, limit);
      return HttpResponse.json({ data: { items, mode: 'keyword' } });
    }),
    http.delete('*/v1/tenants/:tenantId/memory/:memoryId', ({ params }) => {
      const idx = mockMems.findIndex((m) => m.id === params.memoryId);
      if (idx < 0) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '记忆不存在' } }, { status: 404 });
      }
      mockMems.splice(idx, 1);
      return HttpResponse.json({ data: { deleted: true } });
    }),
  ];
}

// ---- F3 mock 数据与 handlers：流水线 / 发布 / 制品库 / 效能 ----
// 注意：module 级内存数据，dev server 热重载时重置；仅供离线演示。
const mockTemplates: Array<Record<string, unknown>> = [];
const mockReleases: Array<Record<string, unknown>> = [];
const mockArtifacts: Array<Record<string, unknown>> = [];
let mockTplSeq = 1;
let mockRelSeq = 1;
let mockArtSeq = 1;

function f3Handlers() {
  return [
    // 流水线模板
    http.get('*/v1/projects/:projectId/delivery/pipeline-templates', () => {
      return HttpResponse.json({ data: mockTemplates });
    }),
    http.post('*/v1/projects/:projectId/delivery/pipeline-templates', async ({ request }) => {
      const body = (await request.json()) as { name?: string; stages?: unknown[] };
      if (!body.name?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '名称必填' } }, { status: 400 });
      }
      const tpl: Record<string, unknown> = {
        id: `ptpl_mock${mockTplSeq++}`, name: body.name.trim(), description: '',
        visibility: 'private', project_id: 'proj_mock', current_version: 1,
        archived_at: null, created_at: now(),
      };
      mockTemplates.unshift(tpl);
      return HttpResponse.json({ data: tpl }, { status: 201 });
    }),
    http.post('*/v1/projects/:projectId/delivery/pipeline-templates/:templateId/instantiate', async ({ request }) => {
      const body = (await request.json()) as { change_package_id?: string };
      if (!body.change_package_id) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: 'change_package_id 必填' } }, { status: 400 });
      }
      return HttpResponse.json({ data: { instance: { id: `pinst_mock${Date.now()}`, status: 'running', created_at: now() }, created: true } });
    }),
    http.get('*/v1/projects/:projectId/delivery/pipeline-runs', () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get('*/v1/projects/:projectId/delivery/change-packages', () => {
      return HttpResponse.json({ data: [{ id: 'cp_mock1', title: '演示变更包', status: 'draft' }] });
    }),
    // 环境与发布
    http.get('*/v1/projects/:projectId/deploy-environments', () => {
      return HttpResponse.json({ data: [
        { id: 'env_stg', key: 'staging', name: '预发', requires_approval: 0 },
        { id: 'env_prod', key: 'prod', name: '生产', requires_approval: 1 },
      ] });
    }),
    http.post('*/v1/projects/:projectId/deploy-environments/ensure-defaults', () => {
      return HttpResponse.json({ data: [
        { id: 'env_stg', key: 'staging', name: '预发', requires_approval: 0 },
        { id: 'env_prod', key: 'prod', name: '生产', requires_approval: 1 },
      ] });
    }),
    http.get('*/v1/projects/:projectId/releases', () => {
      return HttpResponse.json({ data: mockReleases });
    }),
    http.post('*/v1/projects/:projectId/releases', async ({ request }) => {
      const body = (await request.json()) as { environment_key?: string; version?: string; strategy?: string };
      if (!body.version?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '版本必填' } }, { status: 400 });
      }
      const rel: Record<string, unknown> = {
        id: `rel_mock${mockRelSeq++}`, environment_id: 'env_stg', version: body.version.trim(),
        strategy: body.strategy ?? 'canary', status: 'draft',
        requires_approval: body.environment_key === 'prod', approval: null,
        created_at: now(), updated_at: now(),
      };
      mockReleases.unshift(rel);
      return HttpResponse.json({ data: rel }, { status: 201 });
    }),
    http.get('*/v1/projects/:projectId/releases/:releaseId', ({ params }) => {
      const rel = mockReleases.find((r) => r.id === params.releaseId);
      if (!rel) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '发布单不存在' } }, { status: 404 });
      }
      return HttpResponse.json({ data: { release: rel, steps: [] } });
    }),
    ...['request-approval', 'approve', 'reject', 'start', 'rollback'].map((action) =>
      http.post(`*/v1/projects/:projectId/releases/:releaseId/${action}`, ({ params }) => {
        const rel = mockReleases.find((r) => r.id === params.releaseId);
        if (!rel) {
          return HttpResponse.json({ error: { code: 'NOT_FOUND', message: '发布单不存在' } }, { status: 404 });
        }
        const next: Record<string, string> = {
          'request-approval': 'pending_approval', approve: 'approved', reject: 'rejected',
          start: 'succeeded', rollback: 'rolled_back',
        };
        rel.status = next[action];
        return HttpResponse.json({ data: rel });
      }),
    ),
    // 制品库
    http.get('*/v1/projects/:projectId/artifact-packages', () => {
      return HttpResponse.json({ data: mockArtifacts });
    }),
    http.post('*/v1/projects/:projectId/artifact-packages', async ({ request }) => {
      const body = (await request.json()) as { name?: string; kind?: string };
      if (!body.name?.trim()) {
        return HttpResponse.json({ error: { code: 'BAD_REQUEST', message: '包名必填' } }, { status: 400 });
      }
      const pkg: Record<string, unknown> = {
        id: `apkg_mock${mockArtSeq++}`, name: body.name.trim(), kind: body.kind ?? 'generic', created_at: now(),
      };
      (pkg as Record<string, unknown>).versions = [];
      mockArtifacts.unshift(pkg);
      return HttpResponse.json({ data: { ...pkg, versions: undefined } }, { status: 201 });
    }),
    http.get('*/v1/projects/:projectId/artifact-packages/:packageId/versions', ({ params }) => {
      const pkg = mockArtifacts.find((a) => a.id === params.packageId);
      return HttpResponse.json({ data: pkg ? (pkg.versions as unknown[]) : [] });
    }),
    // 效能看板
    http.get('*/v1/projects/:projectId/dora', () => {
      return HttpResponse.json({ data: {
        methodology: 'dora-v1',
        window: { from: now() - 30 * 86400_000, to: now() },
        deployment_frequency: { per_day: 1.2, count: 36, window_days: 30 },
        lead_time: { median_hours: 19.5, p90_hours: 29, count: 30, excluded_no_change_package: 0 },
        change_failure_rate: { rate: 0.11, failed: 4, total: 36 },
        time_to_restore: { median_hours: 4, count: 3, unrecovered: 1 },
      } });
    }),
  ];
}
