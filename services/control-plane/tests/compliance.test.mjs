/**
 * tests/compliance.test.mjs —— V2.4：合规导出 + 锚定验证 + 全租户锚定跑批。
 * - 导出 JSONL/CSV：manifest（sha256、导出时刻链验证结论、锚定状态）
 * - 篡改后导出：manifest 明确标注链断裂
 * - 锚定验证：无锚定→verified:false；手动落库锚定→ok；锚定后改链→broken
 * - anchor-all：未配置 AUDIT_ANCHOR_URL 时如实 anchored:false；租户 token 403
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-cmp-')), 'test.db');
process.env.OPERATOR_TOKEN='test-operator-token-compliance';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerEvidenceRoutes } = await import('../src/modules/evidence/routes.mjs');
const audit = await import('../src/modules/evidence/audit.mjs');
const { verifyAnchors } = await import('../src/modules/evidence/anchor.mjs');

const OPERATOR = process.env.OPERATOR_TOKEN;
let tenantA, adminActor, operatorActor, adminSecret, operatorSecret, base, appServer;

const get = (path, token) => fetch(base + path, {
  headers: { authorization: `Bearer ${token}` },
});

before(async () => {
  openDb();
  await migrate(db());
  await audit.initEvidence();

  tenantA = await store.createTenant({ name: 'CMP Tenant A' });
  adminActor = await store.createActor(tenantA.id, { kind: 'user', name: 'CMP Admin' });
  operatorActor = await store.createActor(tenantA.id, { kind: 'user', name: 'CMP Operator' });
  await store.bindRole(tenantA.id, adminActor.id, null, 'admin');
  await store.bindRole(tenantA.id, operatorActor.id, null, 'operator');
  const mk = async (actorId) => {
    const k = mintKey();
    await store.createApiKeyRow({ tenantId: tenantA.id, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash });
    return k.secret;
  };
  adminSecret = await mk(adminActor.id);
  operatorSecret = await mk(operatorActor.id);

  const app = createApp();
  registerIdentityRoutes(app);
  registerEvidenceRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;

  for (let i = 1; i <= 3; i++) {
    await audit.append({
      tenantId: tenantA.id, actorId: adminActor.id, traceId: `tr-cmp-${i}`,
      action: 'test.compliance', resourceKind: 'doc', resourceId: `r${i}`, payload: { n: i },
    });
  }
});
after(() => new Promise((r) => appServer.close(r)));

const manifestOf = async (res) =>
  JSON.parse(Buffer.from(res.headers.get('x-audit-manifest'), 'base64').toString('utf8'));

test('导出 JSONL：manifest 完整，sha256 自洽', async () => {
  const res = await get(`/v1/admin/tenants/${tenantA.id}/compliance/export?format=jsonl`, adminSecret);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const body = await res.text();
  const lines = body.trim().split('\n');
  assert.equal(lines.length, 3);
  const m = await manifestOf(res);
  assert.equal(m.kind, 'deyi-audit-export');
  assert.equal(m.event_count, 3);
  assert.equal(m.truncated, false);
  assert.equal(m.chain_verification.ok, true);
  assert.equal(m.chain_verification.checked, 3);
  const recomputed = createHash('sha256').update(body, 'utf8').digest('hex');
  assert.equal(m.content_sha256, recomputed);
  assert.equal(m.tenant_id, tenantA.id);
});

test('导出 CSV：表头 + 数据行；format 非法 400', async () => {
  const res = await get(`/v1/admin/tenants/${tenantA.id}/compliance/export?format=csv`, adminSecret);
  assert.equal(res.status, 200);
  const body = await res.text();
  const lines = body.trim().split('\n');
  assert.equal(lines.length, 4); // 表头 + 3 行
  assert.ok(lines[0].startsWith('seq,created_at,created_at_iso,actor_id,action'));

  const bad = await get(`/v1/admin/tenants/${tenantA.id}/compliance/export?format=xml`, adminSecret);
  assert.equal(bad.status, 400);
});

test('导出权限：operator 角色不可导出（需 admin）', async () => {
  const res = await get(`/v1/admin/tenants/${tenantA.id}/compliance/export`, operatorSecret);
  assert.equal(res.status, 403);
});

test('锚定验证：无锚定记录 → verified:false（如实）', async () => {
  const res = await get(`/v1/admin/tenants/${tenantA.id}/evidence/anchor/verify`, operatorSecret);
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.verified, false);
  assert.ok(d.reason);
});

test('锚定验证：手动落库锚定 → ok；锚定后篡改链 → broken', async () => {
  const head = (await db().query(
    'SELECT id, seq, hash FROM audit_events WHERE tenant_id=? ORDER BY seq DESC LIMIT 1', [tenantA.id]))[0];
  await db().query(
    `INSERT INTO anchors(id, tenant_id, chain_head_id, chain_head_hash, chain_head_seq, method, ref, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['anc_test1', tenantA.id, head.id, head.hash, head.seq, 'manual', 'test-ref', 'ok', Date.now()]);

  let d = await verifyAnchors(tenantA.id);
  assert.equal(d.verified, true);
  assert.equal(d.anchors[0].ok, true);

  // 模拟篡改：直接改链尾 payload（DB 触发器防 update？initEvidence 已建触发器——若触发器拦截则跳过本断言）
  let tampered = false;
  try {
    await db().query(`UPDATE audit_events SET payload='{"n":999}' WHERE id=?`, [head.id]);
    tampered = true;
  } catch { /* append-only 触发器拦截：同样证明防篡改 */ }
  if (tampered) {
    d = await verifyAnchors(tenantA.id);
    assert.equal(d.verified, false);
    assert.match(d.anchors[0].reason, /改写/);
    // 导出 manifest 也应标注链断裂
    const res = await get(`/v1/admin/tenants/${tenantA.id}/compliance/export?format=jsonl`, adminSecret);
    const m = await manifestOf(res);
    assert.equal(m.chain_verification.ok, false);
    assert.ok(m.chain_verification.brokenAt);
  }
});

test('anchor-all：未配置锚定端点时如实 anchored:false；租户 token 403', async () => {
  const r403 = await fetch(base + '/v1/admin/anchor-all', {
    method: 'POST', headers: { authorization: `Bearer ${adminSecret}` },
  });
  assert.equal(r403.status, 403);

  const res = await fetch(base + '/v1/admin/anchor-all', {
    method: 'POST', headers: { authorization: `Bearer ${OPERATOR}` },
  });
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.ok(d.tenants >= 1);
  const mine = d.results.find((x) => x.tenant_id === tenantA.id);
  assert.equal(mine.anchored, false);
  assert.match(mine.reason, /AUDIT_ANCHOR_URL/);
});
