/**
 * kernel/config.mjs —— 平台配置：全部来自环境变量，生产启动时做严格校验。
 *
 * 约定：
 * - DEYI_ENV=production 时为生产模式：缺失关键配置直接拒绝启动（fail-fast）。
 * - 开发模式允许 fallback，但会在日志里明确警告。
 */
const DEF = {
  DEYI_ENV: 'development',
  PORT: '8080',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  DATABASE_URL: '',          // 设了就用 PostgreSQL，否则开发模式用 SQLite 文件
  SQLITE_PATH: './data/control-plane.db',
  BOOTSTRAP_ENABLED: 'false',
  BOOTSTRAP_TENANT_NAME: 'default',
  BOOTSTRAP_ADMIN_NAME: 'admin',
  DEV_IDP_SECRET: '',        // 开发模式内置 IdP 的 HMAC 密钥（生产禁止）
  OPERATOR_TOKEN: '',         // 平台运维 token（租户 CRUD）；生产由运维显式设置
  KEYCLOAK_URL: '',          // 设了就走 Keycloak OIDC
  KEYCLOAK_REALM: 'deyi',
  OPA_URL: '',               // 设了就走 OPA，否则用内置策略引擎
  LITELLM_URL: '',           // 设了模型调用就走 LiteLLM，否则直连 Provider（需显式允许）
  LITELLM_MASTER_KEY: '',      // 调用 LiteLLM 的内部 master key（不对外）
  ALLOW_DIRECT_PROVIDER: 'false',
  DIRECT_PROVIDER_BASE_URL: '', // 直连 fallback 的 OpenAI 兼容地址
  DIRECT_PROVIDER_API_KEY: '',  // 直连 fallback 的 key（仅开发容忍，生产走 LiteLLM）
  GATEWAY_TIMEOUT_MS: '120000',
  GATEWAY_MAX_RETRIES: '2',
  QDRANT_URL: '',            // 设了就走 Qdrant，否则用内置本地向量索引（仅开发/测试）
  DOCLING_URL: '',           // 设了就走 Docling 服务，否则用内置解析器（能力降级）
  TEMPORAL_ADDRESS: '',      // 设了就走 Temporal，否则用内置工作流执行器
  AUDIT_ANCHOR_URL: '',      // 外部锚定端点（R13）；未设则只做本地哈希链并警告
};

function load() {
  const cfg = {};
  for (const [k, v] of Object.entries(DEF)) cfg[k] = process.env[k] ?? v;
  cfg.PORT = Number(cfg.PORT);
  cfg.isProd = cfg.DEYI_ENV === 'production';
  cfg.bootstrapEnabled = cfg.BOOTSTRAP_ENABLED === 'true';
  cfg.allowDirectProvider = cfg.ALLOW_DIRECT_PROVIDER === 'true';

  // ---- 启动校验（生产 fail-fast） ----
  const missing = [];
  if (cfg.isProd) {
    if (!cfg.DATABASE_URL) missing.push('DATABASE_URL（生产必须 PostgreSQL）');
    if (!cfg.DEV_IDP_SECRET && !cfg.KEYCLOAK_URL) missing.push('KEYCLOAK_URL（生产禁止内置 IdP）');
    if (!cfg.LITELLM_URL && !cfg.allowDirectProvider) {
      missing.push('LITELLM_URL（生产模型出口必须走 LiteLLM，或显式 ALLOW_DIRECT_PROVIDER=true）');
    }
    if (!cfg.QDRANT_URL) missing.push('QDRANT_URL（生产向量索引必须走 Qdrant）');
    if (!cfg.AUDIT_ANCHOR_URL) missing.push('AUDIT_ANCHOR_URL（生产审计链必须外部锚定）');
    if (cfg.bootstrapEnabled) missing.push('BOOTSTRAP_ENABLED（生产禁止自动 bootstrap）');
  }
  if (missing.length) {
    throw new Error('生产配置校验失败，缺失：\n - ' + missing.join('\n - '));
  }
  return Object.freeze(cfg);
}

export const config = load();
