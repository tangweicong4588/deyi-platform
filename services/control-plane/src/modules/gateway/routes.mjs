/**
 * modules/gateway/routes.mjs —— OpenAI 兼容的网关立面。
 *
 * POST /v1/gw/chat/completions ｜ POST /v1/gw/embeddings
 * 链路：认证 → 项目解析 → 模型白名单 → 数据分级 → 预算/策略 → 上游 →
 *        计量回写（model_calls + budgets）→ 返回。
 * 平台从不记录 prompt 原文（隐私）；只记 token 数与费用。
 */
import { sendJson } from '../../kernel/http.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { ctx, requireTenant } from '../../kernel/context.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { authenticate, tenantScope, requireTenantRole, requireOperator } from '../identity/middleware.mjs';
import { getProject } from '../identity/store.mjs';
import { decide, inputFromRequest } from '../policy/index.mjs';
import * as gstore from './store.mjs';
import { resolveModel, checkDataClass, estimateCost, calcCostCents } from './router.mjs';
import { upstreamFetch, engineKind, isRetryableStatus } from './engines.mjs';
import { logger } from '../../kernel/logging.mjs';

/** 项目解析：Key 绑定的项目优先（更窄），否则看 x-deyi-project 头（必须属于本租户） */
async function resolveProject(reqLike) {
  const c = ctx();
  const pid = c.projectId || reqLike.headers?.['x-deyi-project'] || null;
  if (!pid) return null;
  const p = await getProject(c.tenantId, pid).catch(() => null);
  if (!p) throw Errors.forbidden('项目不存在或无权访问');
  return p;
}

/** 取租户级 + 项目级预算，算出剩余额度（cents / tokens，Infinity = 不限） */
async function budgetState(tenantId, project) {
  const pk = gstore.currentPeriodKey();
  const tenantBudget = await gstore.getBudget(tenantId, null, pk);
  const projectBudget = project ? await gstore.getBudget(tenantId, project.id, pk) : null;
  const remaining = { cost: Infinity, tokens: Infinity };
  for (const b of [tenantBudget, projectBudget]) {
    if (!b || b.status !== 'active') continue;
    if (b.cost_limit_cents != null) remaining.cost = Math.min(remaining.cost, b.cost_limit_cents - b.used_cost_cents);
    if (b.token_limit != null) remaining.tokens = Math.min(remaining.tokens, b.token_limit - b.used_tokens);
  }
  return { tenantBudget, projectBudget, remaining };
}

async function persistUsage({ tenantId, project, actorId, traceId, model, endpoint, usage, latencyMs, status, cached }) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || (promptTokens + completionTokens);
  const costCents = calcCostCents(model, promptTokens, completionTokens);
  await gstore.recordCall({
    tenant_id: tenantId, project_id: project?.id || null, actor_id: actorId, trace_id: traceId,
    model: model.name, litellm_model: model.litellm_model, endpoint,
    prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens,
    cost_cents: costCents, latency_ms: latencyMs, status, cached: cached ? 1 : 0,
  });
  const pk = gstore.currentPeriodKey();
  const tb = await gstore.getBudget(tenantId, null, pk);
  if (tb) await gstore.addUsage(tb.id, totalTokens, costCents);
  if (project) {
    const pb = await gstore.getBudget(tenantId, project.id, pk);
    if (pb) await gstore.addUsage(pb.id, totalTokens, costCents);
  }
  return { totalTokens, costCents };
}

/** SSE 直通：边转发边从 data 块里抓 usage（已注入 stream_options.include_usage） */
async function pipeStream(upRes, res, meta) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
  });
  const t0 = nowMs();
  let usage = null;
  try {
    const reader = upRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.usage) usage = j.usage;
          } catch { /* 非 JSON 的 data 行忽略 */ }
        }
      }
    }
  } catch (e) {
    logger.warn('gateway stream interrupted', { err: String(e) });
  } finally {
    res.end();
    persistUsage({ ...meta, usage: usage || {}, latencyMs: nowMs() - t0, status: 'ok' })
      .catch((e) => logger.error('gateway usage persist failed', { err: String(e) }));
  }
}

/**
 * 网关守卫：认证上下文 → 模型白名单 → 数据分级 → 项目解析 → 策略 → 预算。
 * reqLike: { body, headers }（HTTP req 或内部调用构造的等价对象）。
 * projectOverride: 内部调用方已解析好的项目（跳过头解析；Key 绑定的项目仍优先收窄）。
 */
async function guardAndRoute(reqLike, endpoint, projectOverride = undefined) {
  const c = requireTenant();
  const body = reqLike.body || {};
  const headers = reqLike.headers || {};
  if (!body.model) throw Errors.badRequest('model 必填');
  const model = await resolveModel(body.model);
  const dataClass = checkDataClass(model, headers['x-deyi-data-class']);
  const keyProject = c.projectId ? await resolveProject({ headers: {} }) : null;
  const project = keyProject || projectOverride || await resolveProject(reqLike);
  const est = estimateCost(model, body, endpoint);
  const budgets = await budgetState(c.tenantId, project);

  const receipt = await decide(inputFromRequest({
    actor: { id: c.actorId, kind: c.actorKind, status: 'active', roles: c.roles },
    tenant: { id: c.tenantId, status: 'active' },
    project, action: 'model.invoke',
    resource: { kind: 'model', id: model.id, name: model.name },
    context: {
      budgetRemaining: budgets.remaining.cost, // cents 对 cents
      estimatedCost: est.estimatedCents, dataClass,
    },
  }));
  if (!receipt.allow) {
    if (/预算/.test(receipt.reason)) throw Errors.budgetExceeded({ reason: receipt.reason });
    throw Errors.policyDenied(receipt.reason, { receipt });
  }
  // token 预算在网关层单独卡（单位与费用不同，不能混进上面的 cents 比较）
  if (est.estimatedTokens > budgets.remaining.tokens) {
    throw Errors.budgetExceeded({ reason: 'token 预算不足' });
  }
  return { c, model, project, est, body, dataClass };
}

/**
 * 带降级链的上游调用：主模型失败（网络错误 / 429 / 5xx）后按序试 fallback。
 * 非重试类失败（4xx 等）直接抛，不降级。最终成功返回 { json, usedModel }。
 */
async function callWithFallback(path, body, model, { traceId }) {
  const candidates = [model.litellm_model, ...model.fallback_litellm_models];
  let lastErr = null;
  for (const m of candidates) {
    const ub = { ...body, model: m };
    try {
      const { res: upRes, engineTag } = await upstreamFetch(path, ub, { traceId });
      if (body.stream && upRes.ok) return { stream: upRes, usedModel: m, engineTag };
      let json = null;
      try { json = await upRes.json(); } catch { /* ignore */ }
      if (upRes.ok && json) return { json, usedModel: m, engineTag };
      lastErr = Errors.upstream(`模型调用失败: ${upRes.status}`, { engine: engineTag, status: upRes.status, model: m });
      if (!isRetryableStatus(upRes.status)) break; // 4xx 等不降级
      logger.warn('gateway fallback', { from: m, status: upRes.status });
    } catch (e) {
      lastErr = e;
      // 只有上游类错误才降级；业务/编程错误直接抛
      if (!e || e.code !== 'UPSTREAM_ERROR') throw e;
      logger.warn('gateway fallback', { from: m, err: e.message });
    }
  }
  throw lastErr;
}

async function handleChat(req, res) {
  const { c, model, project, body } = await guardAndRoute(req, 'chat');
  const upstreamBody = {
    ...body,
    model: model.litellm_model, // 平台模型名 → LiteLLM 侧模型名
    user: c.actorId,
    metadata: {
      deyi_tenant_id: c.tenantId,
      deyi_project_id: project?.id || null,
      deyi_trace_id: c.traceId,
    },
  };
  if (upstreamBody.stream) upstreamBody.stream_options = { include_usage: true };

  const t0 = nowMs();
  const meta = {
    tenantId: c.tenantId, project, actorId: c.actorId, traceId: c.traceId,
    model, endpoint: 'chat.completions',
  };
  const { json, stream, usedModel, engineTag } = await callWithFallback(
    '/v1/chat/completions', upstreamBody, model, { traceId: c.traceId })
    .catch(async (e) => {
      await persistUsage({ ...meta, usage: {}, latencyMs: nowMs() - t0, status: 'error' }).catch(() => {});
      throw e;
    });
  if (stream) {
    await pipeStream(stream, res, meta);
    return;
  }
  const { totalTokens, costCents } = await persistUsage({
    ...meta, usage: json.usage || {}, latencyMs: nowMs() - t0, status: 'ok', cached: json._deyi_cached,
  });
  logger.info('gateway chat', {
    model: model.name, via: usedModel, engine: engineTag, tokens: totalTokens, cost_cents: costCents,
  });
  sendJson(res, 200, json);
}

async function handleEmbeddings(req, res) {
  const { c, model, project, body } = await guardAndRoute(req, 'embeddings');
  const upstreamBody = {
    ...body,
    model: model.litellm_model,
    user: c.actorId,
    metadata: { deyi_tenant_id: c.tenantId, deyi_project_id: project?.id || null, deyi_trace_id: c.traceId },
  };
  const t0 = nowMs();
  const meta = {
    tenantId: c.tenantId, project, actorId: c.actorId, traceId: c.traceId,
    model, endpoint: 'embeddings',
  };
  const { json, usedModel, engineTag } = await callWithFallback(
    '/v1/embeddings', upstreamBody, model, { traceId: c.traceId })
    .catch(async (e) => {
      await persistUsage({ ...meta, usage: {}, latencyMs: nowMs() - t0, status: 'error' }).catch(() => {});
      throw e;
    });
  const { totalTokens, costCents } = await persistUsage({
    ...meta, usage: json.usage || {}, latencyMs: nowMs() - t0, status: 'ok',
  });
  logger.info('gateway embeddings', {
    model: model.name, via: usedModel, engine: engineTag, tokens: totalTokens, cost_cents: costCents,
  });
  sendJson(res, 200, json);
}

/**
 * embedInternal —— 内部 embedding 调用（知识平面等模块使用）。
 *
 * 复用当前请求的 tenant/actor/trace 上下文，完整经过网关链路：
 * 模型白名单 → 数据分级 → 策略决策 → 预算预检 → 上游 → 计量回写。
 * 平台内禁止直连 embedding provider，统一走这里。
 *
 * @returns { vectors: number[][], usage, model }
 */
export async function embedInternal({ model: modelName = 'deyi-embedding', input, project = null, dataClass = 'internal' }) {
  const c = requireTenant();
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length || inputs.some((s) => typeof s !== 'string')) {
    throw Errors.badRequest('input 必须是非空字符串或字符串数组');
  }
  const g = await guardAndRoute(
    { body: { model: modelName, input: inputs }, headers: { 'x-deyi-data-class': dataClass } },
    'embeddings', project);
  const upstreamBody = {
    model: g.model.litellm_model,
    input: inputs,
    user: c.actorId,
    metadata: {
      deyi_tenant_id: c.tenantId,
      deyi_project_id: g.project?.id || null,
      deyi_trace_id: c.traceId,
    },
  };
  const t0 = nowMs();
  const meta = {
    tenantId: c.tenantId, project: g.project, actorId: c.actorId, traceId: c.traceId,
    model: g.model, endpoint: 'embeddings',
  };
  const { json, usedModel, engineTag } = await callWithFallback(
    '/v1/embeddings', upstreamBody, g.model, { traceId: c.traceId })
    .catch(async (e) => {
      await persistUsage({ ...meta, usage: {}, latencyMs: nowMs() - t0, status: 'error' }).catch(() => {});
      throw e;
    });
  const usage = json.usage || {};
  await persistUsage({ ...meta, usage, latencyMs: nowMs() - t0, status: 'ok' });
  logger.info('gateway embeddings(internal)', {
    model: g.model.name, via: usedModel, engine: engineTag,
    batch: inputs.length, tokens: usage.total_tokens || 0,
  });
  return { vectors: (json.data || []).map((d) => d.embedding), usage, model: g.model };
}

export function registerGatewayRoutes(app) {  app.post('/v1/gw/chat/completions', authenticate, handleChat);
  app.post('/v1/gw/embeddings', authenticate, handleEmbeddings);

  // 模型目录（租户可见）
  app.get('/v1/models', authenticate, async (req, res) => {
    sendJson(res, 200, { data: await gstore.listModels() });
  });
  // 模型目录管理（平台运维）
  app.post('/v1/admin/models', authenticate, requireOperator, async (req, res) => {
    sendJson(res, 201, { data: await gstore.upsertModel(req.body || {}) });
  });

  // 预算（租户 admin；operator 可带 tenantId 操作任意租户）
  app.get('/v1/admin/tenants/:tenantId/budgets', authenticate, tenantScope, requireTenantRole('admin'),
    async (req, res) => sendJson(res, 200, { data: await gstore.listBudgets(req.params.tenantId) }));
  app.put('/v1/admin/tenants/:tenantId/budgets', authenticate, tenantScope, requireTenantRole('admin'),
    async (req, res) => {
      const { projectId = null, period = 'monthly', costLimitCents = null, tokenLimit = null } = req.body || {};
      sendJson(res, 200, {
        data: await gstore.setBudget({
          tenantId: req.params.tenantId, projectId, period, costLimitCents, tokenLimit,
        }),
      });
    });

  // 用量账本（租户 admin；不含 prompt 原文）
  app.get('/v1/admin/tenants/:tenantId/usage', authenticate, tenantScope, requireTenantRole('admin'),
    async (req, res) => sendJson(res, 200, { data: await gstore.listCalls(req.params.tenantId, req.query.limit) }));
}
