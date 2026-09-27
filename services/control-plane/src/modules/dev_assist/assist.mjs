/**
 * modules/dev_assist/assist.mjs —— V3.5 AI 生产力 Agent（Track A）。
 *
 * 对一次变更运行 AI 助手：
 * - 代码评审（code-review）：产出中文评审报告（严重级别 + 修改建议）
 * - 测试用例生成（testgen）：产出具体测试用例
 * - 变更风险评估（change-risk）：产出风险等级 + 依据 + 缓解建议
 *
 * 实现：复用 V4.4 场景模板实例化 + V4.2 Agent 运行时；llm 节点走网关
 * chatInternal 统一计量，成本按 agent run 的 trace_id（= run.id）从
 * model_calls 归因到变更/项目。
 */
import { newId, nowMs } from '../../kernel/ids.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { db } from '../../db/index.mjs';
import { getChangePackage } from '../delivery/store.mjs';
import { listTemplates, instantiateTemplate } from '../agent_templates/templates.mjs';
import { startRun } from '../agents/agents.mjs';
import { tryAudit } from '../evidence/audit.mjs';

export const ASSIST_KINDS = {
  review: 'code-review',
  testgen: 'testgen',
  risk: 'change-risk',
};
const KIND_LABEL = { review: '代码评审', testgen: '测试用例生成', risk: '变更风险评估' };

const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

/** 按 run trace_id 从 model_calls 汇总 token/成本（网关统一计量口径）。 */
export async function collectRunUsage({ tenantId, runId }) {
  const rows = await db().query(
    `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c,
            COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(cost_cents),0) AS cost,
            COUNT(*) AS n
     FROM model_calls WHERE tenant_id=? AND trace_id=? AND status='ok'`,
    [tenantId, runId],
  );
  const r = rows[0] || {};
  return {
    prompt_tokens: r.p || 0, completion_tokens: r.c || 0,
    total_tokens: r.t || 0, cost_cents: r.cost || 0, calls: r.n || 0,
  };
}

function extractReport(run) {
  const out = run.output;
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.text === 'string') return out.text;
  return JSON.stringify(out);
}

/**
 * 对一次变更运行指定的 AI 助手。diff 由调用方提供（git diff 文本）；
 * context 默认取变更包关联需求的标题+描述。
 */
export async function runAssist({ tenantId, projectId, actorId, changePackageId, kinds, diff, mode = 'simulated', params = {}, bizTaskId = null }) {
  if (!['live', 'simulated'].includes(mode)) throw Errors.badRequest('mode 必须是 live/simulated');
  if (!Array.isArray(kinds) || !kinds.length) throw Errors.badRequest('kinds 必须为非空数组');
  for (const k of kinds) {
    if (!ASSIST_KINDS[k]) throw Errors.badRequest(`未知助手类型: ${k}（可用：${Object.keys(ASSIST_KINDS).join(',')}）`);
  }
  if (!diff || !String(diff).trim()) throw Errors.badRequest('diff 必填（git diff 文本）');
  if (String(diff).length > 200_000) throw Errors.badRequest('diff 过大（上限 200KB）');

  const chg = await getChangePackage(tenantId, changePackageId).catch(() => null);
  if (!chg || chg.project_id !== projectId) throw Errors.notFound('变更包不存在');
  // 变更背景：关联需求标题/描述（best-effort，缺失不阻塞）
  let context = `变更包 ${chg.id}（分支 ${chg.branch || '-'}）`;
  try {
    const req = (await db().query('SELECT title, scope_md FROM requirements WHERE id=? AND tenant_id=?',
      [chg.requirement_id, tenantId]))[0];
    if (req) context = `需求：${req.title}\n${req.scope_md || ''}`.slice(0, 4000);
  } catch { /* best-effort */ }

  // 模板按 key 查找（内置模板 tenant_id NULL）
  const templates = await listTemplates({ tenantId });
  const byKey = new Map(templates.map((t) => [t.key, t]));

  const results = [];
  for (const kind of kinds) {
    const templateKey = ASSIST_KINDS[kind];
    const template = byKey.get(templateKey);
    if (!template) throw Errors.internal(`内置模板缺失: ${templateKey}`);
    const inst = await instantiateTemplate({
      tenantId, projectId, actorId, templateId: template.id,
      params: params[kind] || {},
      agentKey: `aia-${kind}-${newId('tk').slice(3, 11)}`,
      agentName: `${KIND_LABEL[kind]}（${chg.branch || changePackageId}）`,
    });
    const run = await startRun({
      tenantId, projectId, actorId, agentId: inst.agent.id,
      input: { diff: String(diff), context }, mode,
    });
    const usage = await collectRunUsage({ tenantId, runId: run.id });
    const ok = run.status === 'succeeded';
    const id = newId('aia');
    const now = nowMs();
    await db().run(
      `INSERT INTO ai_assist_runs
       (id,tenant_id,project_id,change_package_id,kind,agent_id,run_id,template_key,mode,
        status,report,error,prompt_tokens,completion_tokens,total_tokens,cost_cents,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, projectId, changePackageId, kind, inst.agent.id, run.id, templateKey, mode,
        ok ? 'succeeded' : 'failed', ok ? extractReport(run) : null, ok ? null : (run.error || run.status),
        usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.cost_cents, actorId, now],
    );
    await tryAudit({ tenantId, projectId, actorId, action: 'dev_assist.run',
      resourceKind: 'ai_assist_run', resourceId: id,
      payload: { kind, change_package_id: changePackageId, run_id: run.id, status: run.status, ...usage } });
    if (bizTaskId) {
      // V4.5：为任务执行时登记成本归因边（trace_id = run.id，run 级 trace）
      const { linkCost } = await import('../tasks/cost.mjs');
      await linkCost({ tenantId, projectId, taskId: bizTaskId, kind: 'ai_assist_run', refId: id, traceId: run.id, actorId });
    }
    results.push({
      id, kind, label: KIND_LABEL[kind], status: ok ? 'succeeded' : 'failed',
      agent_id: inst.agent.id, run_id: run.id, template_key: templateKey,
      report: ok ? extractReport(run) : null, error: ok ? null : (run.error || run.status),
      usage, created_at: now,
    });
  }
  const usageTotal = results.reduce((a, r) => ({
    prompt_tokens: a.prompt_tokens + r.usage.prompt_tokens,
    completion_tokens: a.completion_tokens + r.usage.completion_tokens,
    total_tokens: a.total_tokens + r.usage.total_tokens,
    cost_cents: a.cost_cents + r.usage.cost_cents,
    calls: a.calls + r.usage.calls,
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_cents: 0, calls: 0 });
  return { change_package_id: changePackageId, mode, runs: results, usage_total: usageTotal };
}

export async function listAssistRuns({ tenantId, projectId, changePackageId, kind = null }) {
  const rows = await db().query(
    `SELECT * FROM ai_assist_runs
     WHERE tenant_id=? AND project_id=? AND change_package_id=? ${kind ? 'AND kind=?' : ''}
     ORDER BY created_at DESC`,
    kind ? [tenantId, projectId, changePackageId, kind] : [tenantId, projectId, changePackageId],
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, label: KIND_LABEL[r.kind] || r.kind,
    agent_id: r.agent_id, run_id: r.run_id, template_key: r.template_key, mode: r.mode,
    status: r.status, report: r.report, error: r.error,
    usage: {
      prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens,
      total_tokens: r.total_tokens, cost_cents: r.cost_cents,
    },
    created_by: r.created_by, created_at: r.created_at,
  }));
}
