/** runner 测试：V1.0-D 隔离 Runner —— 沙箱逃逸/超时/env 隔离/脱敏/截断/step 策略/复现/跨租户 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'deyi-runner-'));
process.env.SQLITE_PATH = join(scratch, 'test.db');
process.env.OPERATOR_TOKEN = 'op-test-token';
process.env.DEV_IDP_SECRET = 'dev-test-secret';
process.env.BOOTSTRAP_ENABLED = 'false';
process.env.RUNNER_ROOT = join(scratch, 'runner-root');
process.env.RUNNER_MODE = 'live'; // 默认走真隔离；fake 用例内临时切换
delete process.env.GITEA_URL;
process.env.DEIY_RUNNER_SECRET_X = 'shhh-host-secret-123'; // 断言子进程不可见

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const store = await import('../src/modules/identity/store.mjs');
const dstore = await import('../src/modules/delivery/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerDeliveryRoutes } = await import('../src/modules/delivery/routes.mjs');
const isolated = await import('../src/adapters/runner/isolated.mjs');

let tenant, project, adminSecret, viewerSecret;
let tenantB, projectB, bSecret;
let srcDir; // 构建/测试 fixture 源码目录
before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: 'RUNNER Tenant' });
  project = await store.createProject(tenant.id, { name: 'RUNNER Project' });
  const admin = await store.createActor(tenant.id, { kind: 'user', name: 'RUNNER Admin' });
  await store.bindRole(tenant.id, admin.id, null, 'admin');
  const ak = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: admin.id, name: 'runner-admin', prefix: ak.prefix, keyHash: ak.keyHash });
  adminSecret = ak.secret;

  const viewer = await store.createActor(tenant.id, { kind: 'user', name: 'RUNNER Viewer' });
  await store.bindRole(tenant.id, viewer.id, project.id, 'viewer');
  const vk = mintKey();
  await store.createApiKeyRow({ tenantId: tenant.id, actorId: viewer.id, name: 'runner-viewer', prefix: vk.prefix, keyHash: vk.keyHash });
  viewerSecret = vk.secret;

  tenantB = await store.createTenant({ name: 'RUNNER Tenant B' });
  projectB = await store.createProject(tenantB.id, { name: 'RUNNER Project B' });
  const bAdmin = await store.createActor(tenantB.id, { kind: 'user', name: 'B Admin' });
  await store.bindRole(tenantB.id, bAdmin.id, null, 'admin');
  const bk = mintKey();
  await store.createApiKeyRow({ tenantId: tenantB.id, actorId: bAdmin.id, name: 'b-admin', prefix: bk.prefix, keyHash: bk.keyHash });
  bSecret = bk.secret;

  // fixture 源码：确定性构建/测试/扫描脚本
  srcDir = mkdtempSync(join(tmpdir(), 'deyi-runner-src-'));
  writeFileSync(join(srcDir, 'build.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('build.log', 'build-ok');\n`);
  writeFileSync(join(srcDir, 'test.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('test-report.json', JSON.stringify({ passed: 3, failed: 0 }));\n`);
  writeFileSync(join(srcDir, 'scan.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('scan-summary.json', JSON.stringify({ severities: { critical: 0, high: 0 } }));\n`);
  writeFileSync(join(srcDir, 'scan-bad.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('scan-summary.json', JSON.stringify({ severities: { critical: 0, high: 2 } }));\n`);
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerDeliveryRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const D = (pid) => `${base}/v1/projects/${pid}/delivery`;
const post = (url, body, token = adminSecret) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const get = (url, token = adminSecret) =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } });
const P = () => D(project.id);

async function mkReq(title = 'Runner 需求') {
  const r = await post(`${P()}/requirements`, { title, kind: 'feature', scopeMd: '做 X' });
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
async function mkChg(reqId) {
  const r = await post(`${P()}/change-packages`, { requirementId: reqId });
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
async function mkAutoAC(reqId) {
  const r = await post(`${P()}/requirements/${reqId}/acceptance-criteria`,
    { givenMd: 'g', whenMd: 'w', thenMd: 't', kind: 'auto' });
  assert.equal(r.status, 201);
  return (await r.json()).data;
}
const BUILD_CMDS = [{ argv: ['node', 'build.mjs'], name: 'build' }];
const TEST_CMDS = [{ argv: ['node', 'test.mjs'], name: 'test' }];
async function runStep(chgId, step, extra = {}, token = adminSecret) {
  const r = await post(`${P()}/change-packages/${chgId}/steps`,
    { step, sourceDir: srcDir, ...extra }, token);
  return r;
}

// ---------- 适配器直测：沙箱安全 ----------

test('沙箱逃逸被拒：cwd ../../etc', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['node', '-e', '1'], cwd: '../../etc' }] }),
      (e) => e?.details?.code === 'PATH_ESCAPE');
  } finally { isolated.cleanupWorkspace(dir); }
});

test('沙箱逃逸被拒：argv[0] 含 ../', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['../evil', 'x'] }] }),
      (e) => e?.details?.code === 'PATH_ESCAPE');
  } finally { isolated.cleanupWorkspace(dir); }
});

test('拒绝 shell 字符串命令', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: ['node -e "evil"'] }),
      (e) => e?.details?.code === 'SHELL_STRING_REJECTED');
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: 'node --version' }] }),
      (e) => e?.details?.code === 'BAD_ARGV');
  } finally { isolated.cleanupWorkspace(dir); }
});

test('超时 kill：30s 睡眠在 500ms 超时内被杀', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e', 'setTimeout(()=>{},30000)'], name: 'sleep' }],
      limits: { timeoutMs: 500 },
    });
    assert.equal(r.status, 'timeout');
    assert.ok(r.commands[0].timedOut);
    assert.ok(r.durationMs < 8000, `超时未及时杀死（${r.durationMs}ms）`);
    assert.ok(r.limitsEnforced.some((s) => s.startsWith('timeout=')));
  } finally { isolated.cleanupWorkspace(dir); }
});

test('环境变量不继承：宿主 SECRET 不可见，显式 env 可见', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e',
        `console.log('SX=' + (process.env.DEIY_RUNNER_SECRET_X ?? 'absent'));` +
        `console.log('FOO=' + (process.env.FOO ?? 'absent'));` +
        `console.log('HAS_PATH=' + (process.env.PATH ? 'yes' : 'no'));` ] }],
      env: { FOO: 'bar' },
    });
    assert.equal(r.status, 'passed');
    assert.match(r.log, /SX=absent/);
    assert.doesNotMatch(r.log, /shhh-host-secret-123/);
    assert.match(r.log, /FOO=bar/);
    assert.match(r.log, /HAS_PATH=yes/);
  } finally { isolated.cleanupWorkspace(dir); }
});

test('危险环境变量被拒：LD_PRELOAD / PATH 覆盖', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['node', '-e', '1'] }], env: { LD_PRELOAD: '/tmp/x.so' } }),
      (e) => e?.details?.code === 'ENV_DENIED');
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['node', '-e', '1'] }], env: { PATH: '/tmp/evil' } }),
      (e) => e?.details?.code === 'ENV_DENIED');
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['node', '-e', '1'] }], env: { NODE_OPTIONS: '--require /tmp/x' } }),
      (e) => e?.details?.code === 'ENV_DENIED');
  } finally { isolated.cleanupWorkspace(dir); }
});

test('密钥铁律：env 明文凭据被拒，vault 引用放行', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    await assert.rejects(
      isolated.execute({ workdir: dir, commands: [{ argv: ['node', '-e', '1'] }], env: { API_TOKEN: 'sk-abc123' } }),
      (e) => e?.details?.code === 'PLAINTEXT_SECRET');
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e', `console.log('T=' + process.env.API_TOKEN)`] }],
      env: { API_TOKEN: 'vault:ci-token' },
    });
    assert.equal(r.status, 'passed');
    assert.match(r.log, /T=vault:ci-token/);
  } finally { isolated.cleanupWorkspace(dir); }
});

test('日志脱敏：api_key 明文被打码', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e', `console.log('deploying with api_key=sk-live-secret-999 done')`] }],
    });
    assert.equal(r.status, 'passed');
    assert.match(r.log, /api_key=\*\*\*/);
    assert.doesNotMatch(r.log, /sk-live-secret-999/);
  } finally { isolated.cleanupWorkspace(dir); }
});

test('大输出截断：300KB 输出被 64KB 上限截断且打标记', async () => {
  // 注：本沙箱对经 pipe 高速输出 >1MB 的子进程会发 SIGTERM（环境行为，非代码问题），
  // 故用 300KB（仍远大于 64KB 上限）验证截断逻辑。
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e', `for (let i = 0; i < 3000; i++) console.log('x'.repeat(100))`] }],
      limits: { maxOutputBytes: 65536 },
    });
    assert.equal(r.status, 'passed');
    assert.ok(r.logTruncated);
    assert.match(r.log, /truncated/);
    assert.ok(r.log.length < 200000, `日志未被有效截断（${r.log.length}）`);
  } finally { isolated.cleanupWorkspace(dir); }
});

test('fake 模式：simulated:true，绝不伪造真实执行', async () => {
  process.env.RUNNER_MODE = 'fake';
  try {
    const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
    try {
      const r = await isolated.execute({ workdir: dir, commands: [{ argv: ['node', 'never-runs.mjs'] }] });
      assert.equal(r.simulated, true);
      assert.equal(r.status, 'passed');
      assert.match(r.log, /simulated/);
      assert.ok(r.limitsEnforced.some((s) => s.includes('fake')));
    } finally { isolated.cleanupWorkspace(dir); }
  } finally { process.env.RUNNER_MODE = 'live'; }
});

test('workdir 必须在 runnerRoot 内', async () => {
  await assert.rejects(
    isolated.execute({ workdir: tmpdir(), commands: [{ argv: ['node', '-e', '1'] }] }),
    (e) => e?.details?.code === 'PATH_ESCAPE');
});

// ---------- HTTP：step 执行与策略 ----------

test('build step 全流程：执行→产物登记→DoD 打勾', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', {
    commands: BUILD_CMDS, artifacts: [{ kind: 'report', path: 'build.log' }],
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.data.run.status, 'passed');
  assert.equal(body.data.run.simulated, false);
  assert.match(body.data.run.id, /^run_/);
  assert.ok(body.data.run.log_uri.startsWith('file://'));
  assert.equal(body.data.run.artifacts.length, 1);
  assert.equal(body.data.run.artifacts[0].kind, 'report');
  assert.match(body.data.run.artifacts[0].contentHash, /^[0-9a-f]{64}$/);

  // 产物进了 artifacts 表（供门禁消费）
  const arts = await get(`${P()}/change-packages/${chg.id}/artifacts`);
  assert.equal(arts.status, 200);
  const list = (await arts.json()).data;
  assert.ok(list.some((a) => a.kind === 'report' && a.content_hash === body.data.run.artifacts[0].contentHash));

  // DoD build 打勾
  const chgGet = await get(`${P()}/change-packages/${chg.id}`);
  const dod = (await chgGet.json()).data.dod_checklist;
  assert.equal(dod.build.passed, true);
  assert.equal(dod.build.runId, body.data.run.id);
});

test('build 失败阻断', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', { commands: [{ argv: ['node', '-e', 'process.exit(3)'] }] });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.data.run.status, 'failed');
  assert.equal(body.data.run.exit_code, 3);
  assert.equal(body.data.blocked, true);
  assert.ok(body.data.policy.reasons.some((x) => x.includes('阻断')));
  const chgGet = await get(`${P()}/change-packages/${chg.id}`);
  assert.equal((await chgGet.json()).data.dod_checklist.build.passed, false);
});

test('test 失败回写 AC：pending 的 auto AC 被标 failed', async () => {
  const req = await mkReq();
  const ac = await mkAutoAC(req.id);
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'test', { commands: [{ argv: ['node', '-e', 'process.exit(1)'] }] });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.data.run.status, 'failed');
  assert.ok(body.data.policy.acFailed.includes(ac.id));
  const acGet = await get(`${P()}/requirements/${req.id}/acceptance-criteria`);
  const acs = (await acGet.json()).data;
  const hit = acs.find((a) => a.id === ac.id);
  assert.equal(hit.status, 'failed');
  assert.match(hit.evidence_ref, /^runner_run:run_/);
});

test('test 通过不碰 AC', async () => {
  const req = await mkReq();
  const ac = await mkAutoAC(req.id);
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'test', { commands: TEST_CMDS });
  assert.equal((await r.json()).data.run.status, 'passed');
  const acGet = await get(`${P()}/requirements/${req.id}/acceptance-criteria`);
  const hit = (await acGet.json()).data.find((a) => a.id === ac.id);
  assert.equal(hit.status, 'pending');
});

test('scan 高危阻断：high>0 即使 exit 0 也阻断', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'scan', {
    commands: [{ argv: ['node', 'scan-bad.mjs'] }],
    reportFile: 'scan-summary.json',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.data.run.status, 'passed');
  assert.equal(body.data.blocked, true);
  assert.equal(body.data.policy.scan.high, 2);
});

test('scan fail-closed：声明了报告但不可读则阻断', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'scan', {
    commands: [{ argv: ['node', '-e', '1'] }],
    reportFile: 'no-such-report.json',
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.data.blocked, true);
  assert.ok(body.data.policy.scanNote.includes('fail-closed'));
});

test('scan 干净通过不阻断', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'scan', {
    commands: [{ argv: ['node', 'scan.mjs'] }],
    reportFile: 'scan-summary.json',
    artifacts: [{ kind: 'scan_report', path: 'scan-summary.json' }],
  });
  const body = await r.json();
  assert.equal(body.data.blocked, false);
});

// ---------- 复现 ----------

test('reproduce：全新工作区重跑 build+test，结果一致则 DoD 打勾', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const rb = await runStep(chg.id, 'build', {
    commands: BUILD_CMDS, artifacts: [{ kind: 'report', path: 'build.log' }],
  });
  assert.equal((await rb.json()).data.run.status, 'passed');
  const rt = await runStep(chg.id, 'test', {
    commands: TEST_CMDS, artifacts: [{ kind: 'test_report', path: 'test-report.json' }],
  });
  assert.equal((await rt.json()).data.run.status, 'passed');

  const r = await post(`${P()}/change-packages/${chg.id}/reproduce`, {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.data.consistent, true);
  assert.equal(body.data.detail.build.consistent, true);
  assert.equal(body.data.detail.test.consistent, true);
  assert.equal(body.data.detail.build.exitMatch, true);
  assert.equal(body.data.detail.build.hashMatch, true);
  assert.ok(body.data.detail.build.artifacts.every((a) => a.match));

  const chgGet = await get(`${P()}/change-packages/${chg.id}`);
  const dod = (await chgGet.json()).data.dod_checklist;
  assert.equal(dod.reproduce.passed, true);

  // 复现 run 落库且冠名 [reproduce]
  const runs = await get(`${P()}/change-packages/${chg.id}/runner-runs`);
  const names = (await runs.json()).data.map((x) => x.name);
  assert.ok(names.some((n) => n.startsWith('[reproduce]')));
});

test('reproduce 无基线 → 400', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await post(`${P()}/change-packages/${chg.id}/reproduce`, {});
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /NO_BASELINE_RUN/);
});

test('reproduce 拒绝 fake 基线：simulated 不能证明 DoD', async () => {
  process.env.RUNNER_MODE = 'fake';
  let chgId;
  try {
    const req = await mkReq();
    const chg = await mkChg(req.id);
    chgId = chg.id;
    const rb = await runStep(chg.id, 'build', { commands: BUILD_CMDS });
    assert.equal((await rb.json()).data.run.simulated, true);
    const rt = await runStep(chg.id, 'test', { commands: TEST_CMDS });
    assert.equal((await rt.json()).data.run.simulated, true);
  } finally { process.env.RUNNER_MODE = 'live'; }
  const r = await post(`${P()}/change-packages/${chgId}/reproduce`, {});
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(await r.json()), /SIMULATED_NOT_REPRODUCIBLE/);
});

// ---------- 查询与隔离 ----------

test('runner-runs 查询：列表/详情，viewer 可读', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const rb = await runStep(chg.id, 'build', { commands: BUILD_CMDS });
  const runId = (await rb.json()).data.run.id;

  const list = await get(`${P()}/change-packages/${chg.id}/runner-runs`, viewerSecret);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).data.length >= 1);

  const one = await get(`${D(project.id)}/runner-runs/${runId}`, viewerSecret);
  assert.equal(one.status, 200);
  const oneBody = (await one.json()).data;
  assert.equal(oneBody.id, runId);
  assert.ok('log_text' in oneBody);
});

test('step 参数非法：step 非法/commands 为空 → 400', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r1 = await runStep(chg.id, 'deploy', { commands: BUILD_CMDS });
  assert.equal(r1.status, 400);
  const r2 = await runStep(chg.id, 'build', { commands: [] });
  assert.equal(r2.status, 400);
});

test('step 沙箱逃逸经 HTTP 被拒', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', {
    commands: [{ argv: ['node', '-e', '1'], cwd: '../../etc' }],
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /PATH_ESCAPE/);
  // run 行必须落为 failed，不能卡死在 running
  const runs = (await (await get(`${P()}/change-packages/${chg.id}/runner-runs`)).json()).data;
  assert.ok(runs.length >= 1);
  assert.ok(runs.every((x) => x.status !== 'running' && x.status !== 'pending'));
  assert.ok(runs.some((x) => x.status === 'failed'));
});

test('step 总预算：stepTimeoutMs 短于单命令超时时提前杀', async () => {
  const { dir } = isolated.prepareWorkspace({ source: { kind: 'empty' } });
  try {
    const r = await isolated.execute({
      workdir: dir,
      commands: [{ argv: ['node', '-e', 'setTimeout(()=>{},30000)'] }],
      limits: { timeoutMs: 30000, stepTimeoutMs: 500 },
    });
    assert.equal(r.status, 'timeout');
    assert.ok(r.durationMs < 8000);
    assert.ok(r.limitsEnforced.some((s) => s.startsWith('step-timeout=')));
  } finally { isolated.cleanupWorkspace(dir); }
});

test('run 记录 env：复现保真用', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', { commands: BUILD_CMDS, env: { FOO: 'bar' } });
  assert.equal(r.status, 201);
  const run = (await r.json()).data.run;
  assert.equal(run.env.FOO, 'bar');
  const one = await get(`${D(project.id)}/runner-runs/${run.id}`);
  assert.equal((await one.json()).data.env.FOO, 'bar');
});

test('step 明文密钥 env 被拒', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', {
    commands: BUILD_CMDS, env: { DEPLOY_TOKEN: 'plaintext' },
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /PLAINTEXT_SECRET/);
});

test('跨租户隔离：B 租户读 A 的 runner-runs → 403；run 详情跨项目 → 404', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const rb = await runStep(chg.id, 'build', { commands: BUILD_CMDS });
  const runId = (await rb.json()).data.run.id;

  const r1 = await get(`${D(project.id)}/change-packages/${chg.id}/runner-runs`, bSecret);
  assert.equal(r1.status, 403);

  const r2 = await get(`${D(projectB.id)}/runner-runs/${runId}`, bSecret);
  assert.equal(r2.status, 404);
});

test('viewer 无写权限：触发 step → 403', async () => {
  const req = await mkReq();
  const chg = await mkChg(req.id);
  const r = await runStep(chg.id, 'build', { commands: BUILD_CMDS }, viewerSecret);
  assert.equal(r.status, 403);
});
