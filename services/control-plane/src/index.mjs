/**
 * src/index.mjs —— 控制面入口：初始化 DB → 迁移 → bootstrap → 注册路由 → 监听。
 */
import { config } from './kernel/config.mjs';
import { logger, setLogContextProvider } from './kernel/logging.mjs';
import { createApp, sendJson } from './kernel/http.mjs';
import { ctx } from './kernel/context.mjs';
import { openDb, db } from './db/index.mjs';
import { migrate } from './db/migrate.mjs';
import { maybeBootstrap } from './modules/identity/bootstrap.mjs';
import { registerIdentityRoutes } from './modules/identity/routes.mjs';
import { registerGatewayRoutes } from './modules/gateway/routes.mjs';
import { ensureSeedModels } from './modules/gateway/store.mjs';
import { registerKnowledgeRoutes } from './modules/knowledge/routes.mjs';
import { registerOntologyRoutes } from './modules/ontology/routes.mjs';
import { probeVector, getVectorStatus } from './modules/knowledge/vector.mjs';
import { probeDocParse, getDocParseStatus } from './modules/knowledge/docling.mjs';
import { isOpaEnabled } from './modules/policy/opa.mjs';
import { getIdP } from './modules/identity/idp.mjs';

setLogContextProvider(() => {
  const c = ctx();
  return c.traceId ? { trace_id: c.traceId, tenant_id: c.tenantId, actor_id: c.actorId } : {};
});

function adapterStatus() {
  // 各引擎适配器状态：live（已接开源组件）/ fallback（内置降级，仅开发容忍）
  return {
    database: config.DATABASE_URL ? 'postgresql(live)' : 'sqlite(fallback)',
    idp: config.KEYCLOAK_URL ? 'keycloak(live)' : (config.DEV_IDP_SECRET ? 'dev-idp(fallback)' : 'none'),
    policy: isOpaEnabled() ? 'opa(live)' : 'builtin(fallback)',
    model_gateway: config.LITELLM_URL ? 'litellm(live)' : (config.allowDirectProvider ? 'direct(fallback)' : 'none'),
    vector: getVectorStatus(),
    doc_parse: getDocParseStatus(),
    workflow: config.TEMPORAL_ADDRESS ? 'temporal(live)' : 'local(fallback)',
    audit_anchor: config.AUDIT_ANCHOR_URL ? 'configured' : 'none(本地哈希链)',
  };
}

async function main() {
  logger.info('control-plane starting', { env: config.DEYI_ENV, version: '0.5.0' });
  await openDb();
  await migrate(db());
  await maybeBootstrap();
  await ensureSeedModels();
  await probeVector().catch(() => {});
  await probeDocParse().catch(() => {});
  getIdP(); // 打印 IdP 模式日志

  const app = createApp();

  app.get('/healthz', async (req, res) => sendJson(res, 200, { status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    try {
      await db().query('SELECT 1');
      sendJson(res, 200, { status: 'ready', adapters: adapterStatus() });
    } catch (e) {
      sendJson(res, 503, { status: 'not-ready', error: 'db unreachable' });
    }
  });

  registerIdentityRoutes(app);
  registerGatewayRoutes(app);
  registerKnowledgeRoutes(app);
  registerOntologyRoutes(app);
  // P6+ 在此注册：execution / evidence

  const server = await app.listen(config.PORT, config.HOST);
  logger.info('control-plane listening', {
    addr: `http://${config.HOST}:${config.PORT}`,
    adapters: adapterStatus(),
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
