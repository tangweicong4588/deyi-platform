/**
 * tests/backup-restore.test.mjs —— V2.18：备份与恢复（SQLite 级流程测试）。
 *
 * 覆盖：
 * 1. backup-verify.mjs：对备份文件跑逐租户 verifyChain，全绿 exit 0
 * 2. 篡改备份 → verifyChain 失败 → exit 1（完整性校验真能发现损坏）
 * 3. tenant-export → 全新库 tenant-import → 数据回来、审计链完整（单租户恢复）
 * 4. import 幂等：重复导入跳过已存在行
 *
 * PG 脚本（deploy/backup/*.sh）由 shellcheck + DRY_RUN 覆盖（见 runbook），
 * 开发机无 PG，不做真实 pg_dump/pg_restore 演练（诚实边界）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const workdir = mkdtempSync(join(tmpdir(), 'deyi-backup-'));
const DB = join(workdir, 'app.db');
process.env.SQLITE_PATH = DB;

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');

const SCRIPTS = new URL('../scripts/', import.meta.url).pathname;
const nodeBin = process.execPath;
function runScript(name, args, env = {}) {
  try {
    const out = execFileSync(nodeBin, [join(SCRIPTS, name), ...args], {
      // LOG_LEVEL=error：日志走 stdout，压到 error 保证报告 JSON 干净可解析
      env: { ...process.env, LOG_LEVEL: 'error', ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const count = async (t, tenantId) =>
  Number((await db().query(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id=?`, [tenantId]))[0].n);

let tenant, project, actor;

before(async () => {
  await openDb();
  await migrate(db());
  await audit.initEvidence();
  tenant = await store.createTenant({ name: '备份租户' });
  project = await store.createProject(tenant.id, { name: '备份项目', slug: 'bk-proj' });
  actor = await store.createActor(tenant.id, { kind: 'user', name: '备份成员' });
  for (let i = 1; i <= 3; i++) {
    await audit.append({
      tenantId: tenant.id, projectId: project.id, actorId: actor.id,
      traceId: `tr_bk_${i}`, action: 'backup.test', resourceKind: 'doc',
      resourceId: `doc_${i}`, payload: { i },
    });
  }
  await db().query(
    `INSERT INTO model_calls(id, tenant_id, project_id, actor_id, trace_id, model, endpoint,
      prompt_tokens, completion_tokens, total_tokens, cost_cents, latency_ms, status, cached, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['call_bk_1', tenant.id, project.id, actor.id, 'tr_bk_1', 'deyi-chat', 'chat.completions',
     10, 20, 30, 5, 5, 'ok', 0, Date.now()]);
});

test('backup-verify：备份文件审计链完整 → exit 0', () => {
  const r = runScript('backup-verify.mjs', ['--db', DB]);
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(r.out);
  assert.equal(report.ok, true);
  const t = report.tenants.find((x) => x.tenant_id === tenant.id);
  assert.ok(t && t.chain_ok && t.events === 3);
});

test('backup-verify：伪造审计行 → 哈希链断裂 → exit 1', async () => {
  const tampered = join(workdir, 'tampered.db');
  await db().exec('PRAGMA wal_checkpoint(TRUNCATE);'); // WAL 落盘后再拷贝，保证文件完整
  copyFileSync(DB, tampered);
  // 伪造一行（seq=4，prev_hash/hash 对不上链）：模拟绕过应用层的篡改
  execFileSync('sqlite3', [tampered,
    `INSERT INTO audit_events(id, tenant_id, project_id, actor_id, trace_id, action, resource_kind, resource_id, payload, prev_hash, hash, seq, created_at) ` +
    `VALUES ('evd_forged', '${tenant.id}', '${project.id}', '${actor.id}', 'tr_forge', 'backup.test', 'doc', 'doc_x', '{}', 'WRONG', 'WRONG', 4, ${Date.now()});`]);
  const r = runScript('backup-verify.mjs', ['--db', tampered]);
  assert.equal(r.code, 1, '篡改后校验必须失败');
  assert.match(r.out, /"chain_ok": false/);
});

test('单租户恢复：export → 全新库 import → 数据与审计链完整', async () => {
  const expDir = join(workdir, 'export');
  mkdirSync(expDir, { recursive: true });
  const e = runScript('tenant-export.mjs', ['--tenant', tenant.id, '--out', expDir]);
  assert.equal(e.code, 0, e.out);
  const manifest = JSON.parse((await import('node:fs')).readFileSync(join(expDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.tenant_id, tenant.id);
  assert.ok((manifest.tables.audit_events || 0) >= 3);
  assert.equal(manifest.tables.model_calls, 1);

  // 全新库
  const freshDb = join(workdir, 'fresh.db');
  execFileSync(nodeBin, ['-e', `
    process.env.SQLITE_PATH = ${JSON.stringify(freshDb)};
    const { openDb, db } = await import(${JSON.stringify(new URL('../src/db/index.mjs', import.meta.url).href)});
    const { migrate } = await import(${JSON.stringify(new URL('../src/db/migrate.mjs', import.meta.url).href)});
    await openDb(); await migrate(db()); process.exit(0);
  `], { cwd: new URL('../', import.meta.url).pathname });

  const im = runScript('tenant-import.mjs', ['--tenant', tenant.id, '--in', expDir], { SQLITE_PATH: freshDb });
  assert.equal(im.code, 0, im.out);
  const report = JSON.parse(im.out);
  assert.equal(report.tables.audit_events.inserted, 3);

  // 新库校验：审计链完整
  const v = runScript('backup-verify.mjs', ['--db', freshDb]);
  assert.equal(v.code, 0, v.out);
  const vr = JSON.parse(v.out);
  const t = vr.tenants.find((x) => x.tenant_id === tenant.id);
  assert.ok(t.chain_ok && t.events === 3 && t.model_calls === 1);

  // 幂等：重复导入全部跳过
  const im2 = runScript('tenant-import.mjs', ['--tenant', tenant.id, '--in', expDir], { SQLITE_PATH: freshDb });
  assert.equal(im2.code, 0);
  const report2 = JSON.parse(im2.out);
  assert.equal(report2.tables.audit_events.inserted, 0);
  assert.equal(report2.tables.audit_events.skipped, 3);
});

test('tenant-export：不存在的租户 → exit 1', () => {
  const r = runScript('tenant-export.mjs', ['--tenant', 'ten_nope', '--out', join(workdir, 'nope')]);
  assert.equal(r.code, 1);
});
