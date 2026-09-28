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
  DEV_IDP_SECRET: '',        // 开发/测试：本地身份 JWT 的 HMAC 密钥（生产禁止）
  AUTH_JWT_SECRET: '',       // 生产：本地身份 JWT 的 HMAC 密钥（生产必填）
  OPERATOR_TOKEN: '',         // 平台运维 token（租户 CRUD）；生产由运维显式设置
  // 标准 OIDC Client（对接客户已有 IdP；可选，未配则只用本地账号登录）
  OIDC_ISSUER: '',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_REDIRECT_URI: '',
  OIDC_DEFAULT_TENANT_ID: '',
  OIDC_SCOPES: 'openid profile email',
  OIDC_TOTP_ISSUER: 'Deyi',  // TOTP otpauth URL 里的 issuer 显示名
  API_KEY_PEPPER: '',        // API Key hash 的服务端 pepper（生产建议设置）
  // 轮换方法：新 pepper → API_KEY_PEPPER；旧 pepper 移入 _PREVIOUS（逗号分隔），
  // 旧 key 在过渡期内仍可校验；确认全部轮换/过期后再从 _PREVIOUS 移除
  API_KEY_PEPPER_PREVIOUS: '',
  // V2.16 敏感字段落库加密（KMS）：本地 AES-256-GCM 信封加密
  FIELD_ENCRYPTION_KEY: '',      // base64 32B；生产必须设置（缺失时敏感字段写操作 fail-closed）
  FIELD_ENCRYPTION_KEY_ID: 'local-1', // 当前 key 版本 id（写进信封，轮换时换新 id）
  FIELD_ENCRYPTION_KEY_PREVIOUS: '',  // 旧 key（id:base64 逗号分隔），解密旧信封用
  KMS_PROVIDER: 'local',         // local | aws | gcp | alibaba（非 local 暂未实现，预留接口）
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
  RATELIMIT_BACKEND: 'memory', // 限流后端：memory（单实例）| redis（多实例共享计数，Lua 原子）
  REDIS_URL: '',               // redis://[[user]:pass@]host:port[/db]；RATELIMIT_BACKEND=redis 时使用，缺席自动降级内存并告警
  GITEA_URL: '',               // 设了 gitea provider 就走真 Gitea API，否则用 fake（内存/本地 git，仅开发/测试）
  RUNNER_MODE: 'live',          // 隔离 Runner：live=本机隔离执行；fake=内存模拟（simulated:true，仅开发/测试）
  RUNNER_ROOT: '',              // Runner 工作区根目录；未设则用系统临时目录下 deyi-runner
  RUNNER_DEFAULT_TIMEOUT_MS: '600000', // 单条命令默认超时（进程组 SIGKILL）
  RUNNER_MAX_OUTPUT_BYTES: '1048576',  // 单流（stdout/stderr）默认输出上限字节数
  MCP_TIMEOUT_MS: '30000',      // 单次工具调用超时
  EXEC_RESULT_TIMEOUT_MS: '60000', // Temporal 结果轮询上限
  BUSINESS_GRANT_TTL_MS: '900000', // V2.0-B 业务执行短期授权 TTL（默认 15 分钟，上限 60 分钟）
  BUSINESS_VERIFY_TOTAL_TIMEOUT_MS: '120000', // V2.0-C read-back 同步重试总时长熔断（默认 120s）
  AUDIT_ANCHOR_URL: '',      // 外部锚定端点（R13）；未设则只做本地哈希链并警告
  OTEL_EXPORTER_OTLP_ENDPOINT: '', // 设了就发 OTLP/HTTP traces，否则 tracing 全 no-op
  NOTIFY_TIMEOUT_MS: '8000', // 通知 webhook 单次投递超时（同步投递，超时即记 failed）
  NOTIFY_ALLOW_PRIVATE_TARGETS: 'false', // webhook 目标允许内网/回环地址（默认拒绝，防 SSRF；测试可开）
  // V2.14：是否信任反向代理的 x-forwarded-for（key 级 IP 白名单的来源 IP 判定）。
  // 仅当平台部署在"可信、会清洗 XFF"的反向代理之后才设 true；否则伪造 XFF 可绕过白名单。默认 false。
  TRUST_PROXY: 'false',
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
  const prodWarnings = [];
  if (cfg.isProd) {
    if (!cfg.DATABASE_URL) missing.push('DATABASE_URL（生产必须 PostgreSQL）');
    // V2.10：自研轻量身份服务（替代 Keycloak）；生产必须配置 AUTH_JWT_SECRET，禁止开发密钥
    if (!cfg.AUTH_JWT_SECRET) missing.push('AUTH_JWT_SECRET（生产 JWT 签名密钥必须配置）');
    if (cfg.DEV_IDP_SECRET) missing.push('DEV_IDP_SECRET（生产禁止开发密钥）');
    if (!cfg.OPERATOR_TOKEN) missing.push('OPERATOR_TOKEN（生产平台运维必须显式设置）');
    if (!cfg.LITELLM_URL && !cfg.allowDirectProvider) {
      missing.push('LITELLM_URL（生产模型出口必须走 LiteLLM，或显式 ALLOW_DIRECT_PROVIDER=true）');
    }
    if (!cfg.QDRANT_URL) missing.push('QDRANT_URL（生产向量索引必须走 Qdrant）');
    if (!cfg.AUDIT_ANCHOR_URL) missing.push('AUDIT_ANCHOR_URL（生产审计链必须外部锚定）');
    if (cfg.bootstrapEnabled) missing.push('BOOTSTRAP_ENABLED（生产禁止自动 bootstrap）');
    if (!cfg.API_KEY_PEPPER) prodWarnings.push('API_KEY_PEPPER 未设置：API Key hash 缺少服务端 pepper 纵深（建议设置）');
    if (!cfg.FIELD_ENCRYPTION_KEY) prodWarnings.push('FIELD_ENCRYPTION_KEY 未设置：TOTP secret 等敏感字段写操作将 fail-closed（503），生产必须设置');
    // 生产 fake 适配器显式告警（H-7 安全 review）：缺失即静默回退 fake，必须让运维看见
    if (!cfg.GITEA_URL) prodWarnings.push('GITEA_URL 未设置：仓库服务将使用 fake 适配器（simulated），生产请接入真 Gitea');
    if (!cfg.TEMPORAL_ADDRESS) prodWarnings.push('TEMPORAL_ADDRESS 未设置：工作流将使用内置执行器，生产请接入 Temporal');
    if (!cfg.DOCLING_URL) prodWarnings.push('DOCLING_URL 未设置：文档解析将使用内置解析器（能力降级），生产请接入 Docling');
    if (cfg.RUNNER_MODE !== 'live') prodWarnings.push(`RUNNER_MODE=${cfg.RUNNER_MODE}：隔离 Runner 未启用 live 模式`);
  }
  if (missing.length) {
    throw new Error('生产配置校验失败，缺失：\n - ' + missing.join('\n - '));
  }
  cfg.prodWarnings = Object.freeze(prodWarnings);
  return Object.freeze(cfg);
}

export const config = load();
