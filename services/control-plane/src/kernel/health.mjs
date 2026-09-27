/**
 * kernel/health.mjs —— V2.11 健康检查与就绪探针。
 *
 * GET /healthz：轻量存活探针。不碰 DB、不碰任何适配器（kubelet liveness 用，
 * 必须永远廉价）。只返回进程自身状态。
 *
 * GET /readyz：就绪探针（kubelet readiness 用）。
 *   1. DB 可写探测：对 readiness_probe（迁移 026）做单行 upsert，证明数据库
 *      可写而不仅是连通。失败 → ready=false → HTTP 503。
 *   2. 各适配器按配置做轻量 ping（单次 2s 超时，结果缓存 10s）：
 *      - 已配置且可达 → up；已配置但不可达 → down；
 *      - 未配置 → unknown。
 *      适配器状态只写进 body.checks 上报，永远不改变 HTTP 状态码（未配置的
 *      依赖不阻塞 ready；已配置但降级中的依赖也不阻塞——平台有内置 fallback，
 *      阻塞 ready 会导致 K8s 把仍可服务的副本踢出）。
 *   3. body 保留 legacy `adapters` 字段（部署文档/旧脚本引用），新增 `checks`。
 *
 * 测试可注入：registerHealthRoutes(app, { readiness })；checkReadiness(h) 接受
 * 任意 db 句柄，便于用故障句柄验证 503 路径。
 */
import net from 'node:net';
import { config } from './config.mjs';
import { db } from '../db/index.mjs';
import { sendJson } from './http.mjs';
import { logger } from './logging.mjs';
import { isOpaEnabled } from '../modules/policy/opa.mjs';
import { getVectorStatus } from '../modules/knowledge/vector.mjs';
import { getDocParseStatus } from '../modules/knowledge/docling.mjs';
import { getWorkflowStatus } from '../modules/execution/temporal.mjs';
import { getRepoAdapterStatus } from '../adapters/gitea/client.mjs';
import { getPipelineAdapterStatus } from '../adapters/pipeline/adapter.mjs';

export const SERVICE_VERSION = '0.5.0';

/** 启动日志用的各引擎适配器状态（V2.10 前在 index.mjs，V2.11 迁入此处统一）。 */
export function adapterSummary() {
  // 各引擎适配器状态：live（已接开源组件）/ fallback（内置降级，仅开发容忍）
  return {
    database: config.DATABASE_URL ? 'postgresql(live)' : 'sqlite(fallback)',
    idp: (config.AUTH_JWT_SECRET || config.DEV_IDP_SECRET) ? 'local-idp' : 'none',
    oidc: (config.OIDC_ISSUER && config.OIDC_CLIENT_ID) ? 'oidc-client' : 'none',
    policy: isOpaEnabled() ? 'opa(live)' : 'builtin(fallback)',
    model_gateway: config.LITELLM_URL ? 'litellm(live)' : (config.allowDirectProvider ? 'direct(fallback)' : 'none'),
    vector: getVectorStatus(),
    doc_parse: getDocParseStatus(),
    workflow: getWorkflowStatus(),
    repo: getRepoAdapterStatus(),
    ci: getPipelineAdapterStatus(),
    audit_anchor: config.AUDIT_ANCHOR_URL ? 'configured' : 'none(本地哈希链)',
    tracing: 'noop', // tracing 状态由 index.mjs 启动日志单独打印
  };
}

const PROBE_TIMEOUT_MS = 2000;   // 单个适配器 ping 超时
const PROBE_CACHE_TTL_MS = 10_000; // 适配器探测结果缓存（readyz 被 kubelet 高频调用）
const probeCache = new Map();    // name -> { at, result }
const probeInflight = new Map(); // name -> Promise（并发 readyz 去重）

function errText(e) {
  return String(e?.message || e).slice(0, 120);
}

/** HTTP 轻量 ping：200 即 up（含 LiteLLM /health、OPA /health、Docling /health、Qdrant /）。 */
export async function pingHttp(name, url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return { name, status: 'up', latency_ms: Date.now() - started };
  } catch (e) {
    return { name, status: 'down', latency_ms: Date.now() - started, error: errText(e) };
  }
}

/** TCP ping：Temporal TEMPORAL_ADDRESS 是 host:port（gRPC），用建连证明端口存活。 */
export function pingTcp(name, hostPort) {
  return new Promise((resolve) => {
    const started = Date.now();
    const m = String(hostPort).replace(/^[a-z]+:\/\//i, '').split(':');
    const host = m[0];
    const port = Number(m[1]) || 7233;
    const sock = net.connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    const done = (status, error) => {
      sock.destroy();
      resolve({ name, status, latency_ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    sock.once('connect', () => done('up'));
    sock.once('timeout', () => done('down', 'tcp timeout'));
    sock.once('error', (e) => done('down', errText(e)));
  });
}

const unknown = (name) => ({ name, status: 'unknown', reason: 'not-configured' });

/** 单个适配器检查：未配置 → unknown；配置了 → live ping（带缓存/并发去重）。测试可直接调用验证缓存语义。 */
export function cachedCheck(name, configured, run) {
  if (!configured) return Promise.resolve(unknown(name));
  const now = Date.now();
  const hit = probeCache.get(name);
  if (hit && now - hit.at < PROBE_CACHE_TTL_MS) return Promise.resolve(hit.result);
  let p = probeInflight.get(name);
  if (!p) {
    p = run().then((r) => {
      probeCache.set(name, { at: Date.now(), result: r });
      probeInflight.delete(name);
      return r;
    }).catch((e) => {
      probeInflight.delete(name);
      const r = { name, status: 'down', error: errText(e) };
      probeCache.set(name, { at: Date.now(), result: r });
      return r;
    });
    probeInflight.set(name, p);
  }
  return p;
}

/** DB 可写探测：readiness_probe 单行 upsert。每次 readyz 都真实执行，不缓存。 */
export async function probeDbWritable(h) {
  const started = Date.now();
  const now = Date.now();
  await h.query(
    `INSERT INTO readiness_probe(id, checked_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at`,
    [now],
  );
  return { name: 'database', status: 'up', latency_ms: Date.now() - started };
}

/**
 * 就绪检查主函数。h 默认为真实 db；测试可传入故障句柄。
 * ready 只由 DB 可写探测决定；适配器状态仅上报。
 */
export async function checkReadiness(h = db()) {
  const checks = {};
  let ready = true;
  let dbError;
  try {
    checks.database = await probeDbWritable(h);
  } catch (e) {
    ready = false;
    dbError = errText(e);
    checks.database = { name: 'database', status: 'down', error: dbError };
  }

  const strip = (u) => String(u).replace(/\/$/, '');
  const [vector, docParse, workflow, modelGateway, policy, oidc] = await Promise.all([
    cachedCheck('vector', !!config.QDRANT_URL, () => pingHttp('vector', strip(config.QDRANT_URL) + '/')),
    cachedCheck('doc_parse', !!config.DOCLING_URL, () => pingHttp('doc_parse', strip(config.DOCLING_URL) + '/health')),
    cachedCheck('workflow', !!config.TEMPORAL_ADDRESS, () => pingTcp('workflow', config.TEMPORAL_ADDRESS)),
    cachedCheck('model_gateway', !!config.LITELLM_URL, () => pingHttp('model_gateway', strip(config.LITELLM_URL) + '/health')),
    cachedCheck('policy', !!config.OPA_URL, () => pingHttp('policy', strip(config.OPA_URL) + '/health')),
    cachedCheck('oidc', !!(config.OIDC_ISSUER && config.OIDC_CLIENT_ID),
      () => pingHttp('oidc', strip(config.OIDC_ISSUER) + '/.well-known/openid-configuration')),
  ]);
  checks.vector = vector;
  checks.doc_parse = docParse;
  checks.workflow = workflow;
  checks.model_gateway = modelGateway;
  checks.policy = policy;
  checks.oidc = oidc;
  // 纯配置型（不 ping）：本地 IdP、审计锚定
  checks.idp = { name: 'idp', status: (config.AUTH_JWT_SECRET || config.DEV_IDP_SECRET) ? 'up' : 'unknown', ...(config.AUTH_JWT_SECRET || config.DEV_IDP_SECRET ? { detail: 'local-idp' } : { reason: 'not-configured' }) };
  checks.audit_anchor = config.AUDIT_ANCHOR_URL
    ? { name: 'audit_anchor', status: 'up', detail: 'configured' }
    : { name: 'audit_anchor', status: 'unknown', reason: 'not-configured' };

  return {
    ready,
    ...(dbError ? { db_error: dbError } : {}),
    checks,
    adapters: adapterSummary(),
  };
}

/** 轻量存活：绝不碰 DB/适配器。 */
export function liveness() {
  return { status: 'ok', version: SERVICE_VERSION, uptime_s: Math.floor(process.uptime()) };
}

export function registerHealthRoutes(app, deps = {}) {
  const readiness = deps.readiness || checkReadiness;
  app.get('/healthz', async (req, res) => sendJson(res, 200, liveness()));
  app.get('/readyz', async (req, res) => {
    try {
      const r = await readiness();
      sendJson(res, r.ready ? 200 : 503, {
        status: r.ready ? 'ready' : 'not-ready',
        checks: r.checks,
        adapters: r.adapters,
        ...(r.db_error ? { error: r.db_error } : {}),
      });
    } catch (e) {
      logger.warn('readyz 异常', { error: errText(e) });
      sendJson(res, 503, { status: 'not-ready', error: 'readiness check failed' });
    }
  });
}

/** 仅测试用：清掉适配器探测缓存。 */
export function __clearProbeCache() {
  probeCache.clear();
  probeInflight.clear();
}
