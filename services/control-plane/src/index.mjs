/**
 * src/index.mjs —— 控制面入口：初始化 DB → 迁移 → bootstrap → 注册路由 → 监听。
 */
import { config } from './kernel/config.mjs';
import { logger, setLogContextProvider } from './kernel/logging.mjs';
import { createApp } from './kernel/http.mjs';
import { ctx } from './kernel/context.mjs';
import { openDb, db } from './db/index.mjs';
import { migrate } from './db/migrate.mjs';
import { maybeBootstrap } from './modules/identity/bootstrap.mjs';
import { registerIdentityRoutes } from './modules/identity/routes.mjs';
import { registerAuthRoutes } from './modules/identity/auth-routes.mjs';
import { registerGatewayRoutes } from './modules/gateway/routes.mjs';
import { ensureSeedModels } from './modules/gateway/store.mjs';
import { registerKnowledgeRoutes } from './modules/knowledge/routes.mjs';
import { registerOntologyRoutes } from './modules/ontology/routes.mjs';
import { registerExecutionRoutes } from './modules/execution/routes.mjs';
import { registerEvidenceRoutes } from './modules/evidence/routes.mjs';
import { registerDeliveryRoutes } from './modules/delivery/routes.mjs';
import { registerBusinessRoutes } from './modules/business/routes.mjs';
import { registerTaskRoutes } from './modules/tasks/routes.mjs';
import { registerReleaseRoutes } from './modules/release/routes.mjs';
import { registerAgentRoutes } from './modules/agents/routes.mjs';
import { registerNotifyRoutes } from './modules/notify/routes.mjs';
import { registerMemoryRoutes } from './modules/memory/routes.mjs';
import { registerBillingRoutes } from './modules/billing/routes.mjs';
import { registerOpenApiRoutes } from './modules/openapi/routes.mjs';
import { initEvidence } from './modules/evidence/audit.mjs';
import { tracingMiddleware, isTracingEnabled } from './kernel/tracing.mjs';
import { probeVector } from './modules/knowledge/vector.mjs';
import { probeDocParse } from './modules/knowledge/docling.mjs';
import { probeTemporal } from './modules/execution/temporal.mjs';
import { registerHealthRoutes, adapterSummary } from './kernel/health.mjs';
import { getIdP } from './modules/identity/idp.mjs';

setLogContextProvider(() => {
  const c = ctx();
  return c.traceId ? { trace_id: c.traceId, tenant_id: c.tenantId, actor_id: c.actorId } : {};
});

async function main() {
  logger.info('control-plane starting', { env: config.DEYI_ENV, version: '0.5.0' });
  // H-7 安全 review：生产启用 fake/fallback 适配器必须显式告警（config 已收集 prodWarnings）
  for (const w of config.prodWarnings || []) logger.warn('生产 fake 适配器告警: ' + w);
  await openDb();
  await migrate(db());
  await initEvidence();
  await maybeBootstrap();
  await ensureSeedModels();
  await probeVector().catch(() => {});
  await probeDocParse().catch(() => {});
  await probeTemporal().catch(() => {});
  getIdP(); // 打印 IdP 模式日志

  const app = createApp();
  app.use(tracingMiddleware); // http.server span；无 OTEL 端点时 no-op
  logger.info('tracing', { otlp: isTracingEnabled() ? 'enabled' : 'disabled(no-op)' });

  registerHealthRoutes(app); // V2.11：/healthz 轻量存活，/readyz DB 可写探测 + 适配器 ping

  registerIdentityRoutes(app);
  registerAuthRoutes(app);
  registerGatewayRoutes(app);
  registerKnowledgeRoutes(app);
  registerOntologyRoutes(app);
  registerExecutionRoutes(app);
  registerEvidenceRoutes(app);
  registerDeliveryRoutes(app);
  registerBusinessRoutes(app);
  registerTaskRoutes(app);
  registerReleaseRoutes(app);
  registerAgentRoutes(app);
  registerNotifyRoutes(app);
  registerMemoryRoutes(app);
  registerBillingRoutes(app);
  registerOpenApiRoutes(app); // V2.9：必须在所有业务路由注册之后（快照完整路由表）
  const server = await app.listen(config.PORT, config.HOST);
  logger.info('control-plane listening', {
    addr: `http://${config.HOST}:${config.PORT}`,
    adapters: { ...adapterSummary(), tracing: isTracingEnabled() ? 'otlp(live)' : 'noop' },
  });

  const shutdown = () => {
    logger.info('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  logger.error('startup failed', { err: String(e && e.stack || e) });
  process.exit(1);
});
