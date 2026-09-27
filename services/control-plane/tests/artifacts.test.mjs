/** V3.3 制品库测试：建包/上传下载/版本/关联/保留清扫/鉴权隔离 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-art-')), 'test.db');
process.env.ARTIFACT_STORE_DIR = mkdtempSync(join(tmpdir(), 'deyi-artifacts-'));
process.env.OPERATOR_TOKEN = 'op_test_token_artifact33';
process.env.DEV_IDP_SECRET = 'dev-secret-artifact33';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { mintKey } = await import('../src/modules/identity/keys.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');
const { registerArtifactRoutes } = await import('../src/modules/artifacts/routes.mjs');
const { sweepTenant } = await import('../src/modules/evidence/retention.mjs');
const artStore = await import('../src/modules/artifacts/store.mjs');

async function mkKey(tenantId, actorId, projectId = null, scopes = []) {
  const k = mintKey();
  await store.createApiKeyRow({ tenantId, projectId, actorId, name: 'k', prefix: k.prefix, keyHash: k.keyHash, scopes });
  return k.secret;
}

let tenantA, tenantB, adminA, viewerA, pA1, pB1, adminKeyA, viewerKeyA, readOnlyKeyA, adminKeyB;
before(async () => {
  await openDb();
  await migrate(db());

  tenantA = await store.createTenant({ name: 'Art Tenant A' });
  adminA = await store.createActor(tenantA.id, { kind: 'user', name: 'Admin A' });
  await store.bindRole(tenantA.id, adminA.id, null, 'admin');
  adminKeyA = await mkKey(tenantA.id, adminA.id);
  readOnlyKeyA = await mkKey(tenantA.id, adminA.id, null, ['artifacts.read']);

  viewerA = await store.createActor(tenantA.id, { kind: 'user', name: 'Viewer A' });
  pA1 = await store.createProject(tenantA.id, { name: 'Art Project 1' });
  await store.bindRole(tenantA.id, viewerA.id, pA1.id, 'viewer');
  viewerKeyA = await mkKey(tenantA.id, viewerA.id);

  tenantB = await store.createTenant({ name: 'Art Tenant B' });
  const adminB = await store.createActor(tenantB.id, { kind: 'user', name: 'Admin B' });
  await store.bindRole(tenantB.id, adminB.id, null, 'admin');
  adminKeyB = await mkKey(tenantB.id, adminB.id);
  pB1 = await store.createProject(tenantB.id, { name: 'Art Project B1' });
});

let base, appServer;
before(async () => {
  const app = createApp();
  registerIdentityRoutes(app);
  registerArtifactRoutes(app);
  appServer = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => new Promise((r) => appServer.close(r)));

const H = (key) => ({ authorization: `Bearer ${key}` });
async function api(method, path, key, { body, rawBody, ctype, query = '' } = {}) {
  const headers = { ...H(key) };
  let payload;
  if (rawBody !== undefined) {
    headers['content-type'] = ctype || 'application/octet-stream';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + path + query, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 二进制下载 */ }
  return { status: r.status, json, text, headers: r.headers };
}
const pkgBase = (pid) => `/v1/projects/${pid}/artifact-packages`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let pkgA; // 主测试包
const content1 = Buffer.from('fake-image-bytes-'.repeat(100));

test('建包成功；同名 409；非法 kind 400', async () => {
  const r = await api('POST', pkgBase(pA1.id), adminKeyA, {
    body: { name: 'svc/api', kind: 'image', description: 'api 镜像' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.data.name, 'svc/api');
  pkgA = r.json.data;

  const dup = await api('POST', pkgBase(pA1.id), adminKeyA, { body: { name: 'svc/api', kind: 'image' } });
  assert.equal(dup.status, 409);

  const bad = await api('POST', pkgBase(pA1.id), adminKeyA, { body: { name: 'x', kind: 'nope' } });
  assert.equal(bad.status, 400);
});

test('包列表/详情；租户隔离（B 看不到 A 的包）', async () => {
  const l = await api('GET', pkgBase(pA1.id), adminKeyA);
  assert.equal(l.status, 200);
  assert.ok(l.json.data.some((p) => p.id === pkgA.id));

  const g = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}`, viewerKeyA);
  assert.equal(g.status, 200);

  const cross = await api('GET', pkgBase(pB1.id), adminKeyB);
  assert.equal(cross.status, 200);
  assert.ok(!cross.json.data.some((p) => p.id === pkgA.id));
});

test('viewer 建包 403；只读 scope 的 key 上传 403', async () => {
  const r = await api('POST', pkgBase(pA1.id), viewerKeyA, { body: { name: 'v/x', kind: 'binary' } });
  assert.equal(r.status, 403);

  const up = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, readOnlyKeyA, {
    rawBody: content1, query: '?version=9.9.9',
  });
  assert.equal(up.status, 403);
});

let ver1;
test('上传版本：sha256/size 正确；重复版本 409；非法 version 400', async () => {
  const r = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: content1, query: '?version=1.0.0&filename=api.tar&metadata=' + encodeURIComponent('{"go":"1.22"}'),
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.data.content_hash, sha256(content1));
  assert.equal(r.json.data.size_bytes, content1.length);
  assert.equal(r.json.data.status, 'active');
  assert.deepEqual(r.json.data.metadata, { go: '1.22' });
  ver1 = r.json.data;

  const dup = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: content1, query: '?version=1.0.0',
  });
  assert.equal(dup.status, 409);

  const bad = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: content1, query: '?version=../evil',
  });
  assert.equal(bad.status, 400);

  const noVer = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, { rawBody: content1 });
  assert.equal(noVer.status, 400);

  const notBin = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    body: { version: '2.0.0' }, query: '?version=2.0.0',
  });
  assert.equal(notBin.status, 400);
});

test('下载字节一致；etag/content-length 头正确；viewer 可下载', async () => {
  const r = await fetch(
    `${base}${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/download`,
    { headers: H(viewerKeyA) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), `"${sha256(content1)}"`);
  assert.equal(Number(r.headers.get('content-length')), content1.length);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.equals(content1));
});

test('版本列表/详情（按 id 与按 version 串均可查）', async () => {
  const l = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, viewerKeyA);
  assert.equal(l.status, 200);
  assert.ok(l.json.data.some((v) => v.id === ver1.id));

  const byId = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/${ver1.id}`, viewerKeyA);
  assert.equal(byId.status, 200);
  const byVer = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, viewerKeyA);
  assert.equal(byVer.status, 200);
  assert.equal(byVer.json.data.id, ver1.id);
});

test('改状态：deprecated/pinned；非法 status 400', async () => {
  const d = await api('PATCH', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, adminKeyA, {
    body: { status: 'deprecated' },
  });
  assert.equal(d.status, 200);
  assert.equal(d.json.data.status, 'deprecated');

  const p = await api('PATCH', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, adminKeyA, {
    body: { status: 'pinned' },
  });
  assert.equal(p.json.data.status, 'pinned');

  const bad = await api('PATCH', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, adminKeyA, {
    body: { status: 'lost' },
  });
  assert.equal(bad.status, 400);
  // 恢复 active，避免影响后续保留测试
  await api('PATCH', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, adminKeyA, { body: { status: 'active' } });
});

test('关联：目标不存在 404；link_kind 非法 400；正向 link/去重/列表/解关联', async () => {
  const nf = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links`, adminKeyA, {
    body: { link_kind: 'release', link_id: 'rel_missing' },
  });
  assert.equal(nf.status, 404);
  const badKind = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links`, adminKeyA, {
    body: { link_kind: 'rocket', link_id: 'x' },
  });
  assert.equal(badKind.status, 400);

  // fixture：直接插一行 release
  const envId = `env_${Date.now()}`;
  await db().query(
    'INSERT INTO deploy_environments(id,tenant_id,project_id,key,name,created_at) VALUES (?,?,?,?,?,?)',
    [envId, tenantA.id, pA1.id, 'prod', 'Prod', Date.now()]);
  const relId = `rel_${Date.now()}`;
  await db().query(
    `INSERT INTO releases(id,tenant_id,project_id,environment_id,version,strategy,status,requires_approval,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [relId, tenantA.id, pA1.id, envId, '1.0.0', 'rolling', 'succeeded', 0, adminA.id, Date.now(), Date.now()]);

  const ok = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links`, adminKeyA, {
    body: { link_kind: 'release', link_id: relId },
  });
  assert.equal(ok.status, 201);
  const dup = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links`, adminKeyA, {
    body: { link_kind: 'release', link_id: relId },
  });
  assert.equal(dup.status, 409);

  const list = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links`, viewerKeyA);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.some((l) => l.link_id === relId));

  const rm = await api('DELETE',
    `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links/${ok.json.data.id}`, adminKeyA);
  assert.equal(rm.status, 200);
  const rm2 = await api('DELETE',
    `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0/links/${ok.json.data.id}`, adminKeyA);
  assert.equal(rm2.status, 404);
});

test('删除版本：引用计数——同内容两版本，删一个 blob 保留，删完 blob 才删', async () => {
  const a = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: content1, query: '?version=1.0.1',
  });
  assert.equal(a.status, 201);
  // 与 1.0.0 同内容 → 同一 blob（去重）
  assert.equal(a.json.data.content_hash, ver1.content_hash);

  const blobRel = artStore.blobPathFor(ver1.content_hash);
  const blobAbs = join(process.env.ARTIFACT_STORE_DIR, blobRel);
  const del1 = await api('DELETE', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.1`, adminKeyA);
  assert.equal(del1.status, 200);
  assert.equal(del1.json.data.blob_removed, false);
  assert.ok(existsSync(blobAbs), '仍有 1.0.0 引用，blob 应保留');

  const del2 = await api('DELETE', `${pkgBase(pA1.id)}/${pkgA.id}/versions/1.0.0`, adminKeyA);
  assert.equal(del2.status, 200);
  assert.equal(del2.json.data.blob_removed, true);
  assert.ok(!existsSync(blobAbs), '无引用后 blob 应删除');
});

test('上传产生审计事件 artifact.version.upload', async () => {
  const rows = await db().query(
    `SELECT id FROM audit_events WHERE tenant_id=? AND action='artifact.version.upload' ORDER BY seq DESC LIMIT 1`,
    [tenantA.id]);
  assert.ok(rows.length >= 1, '应有上传审计事件');
});

test('保留清扫：过期未钉住的删；pinned 与 release 关联的保留；包级覆盖生效', async () => {
  const old = Date.now() - 400 * 86400_000;
  // vOld：过期、无关联 → 应被清扫
  const vOld = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: Buffer.from('old-bytes'), query: '?version=0.0.1',
  });
  // vPin：过期但 pinned → 保留
  const vPin = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: Buffer.from('pinned-bytes'), query: '?version=0.0.2',
  });
  await api('PATCH', `${pkgBase(pA1.id)}/${pkgA.id}/versions/0.0.2`, adminKeyA, { body: { status: 'pinned' } });
  // vRel：过期但关联 release → 保留
  const vRel = await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions`, adminKeyA, {
    rawBody: Buffer.from('rel-bytes'), query: '?version=0.0.3',
  });
  const envRows = await db().query('SELECT id FROM deploy_environments WHERE tenant_id=? LIMIT 1', [tenantA.id]);
  const relId2 = `rel_keep_${Date.now()}`;
  await db().query(
    `INSERT INTO releases(id,tenant_id,project_id,environment_id,version,strategy,status,requires_approval,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [relId2, tenantA.id, pA1.id, envRows[0].id, '0.0.3', 'rolling', 'succeeded', 0, adminA.id, Date.now(), Date.now()]);
  await api('POST', `${pkgBase(pA1.id)}/${pkgA.id}/versions/0.0.3/links`, adminKeyA, {
    body: { link_kind: 'release', link_id: relId2 },
  });
  for (const v of [vOld, vPin, vRel]) {
    await db().query('UPDATE artifact_versions SET created_at=? WHERE id=?', [old, v.json.data.id]);
  }
  const oldBlobAbs = join(process.env.ARTIFACT_STORE_DIR,
    artStore.blobPathFor(vOld.json.data.content_hash));
  assert.ok(existsSync(oldBlobAbs));

  // dryRun 只计数
  const dry = await sweepTenant(tenantA.id, { dryRun: true });
  assert.ok(dry.deleted.artifacts >= 1, `dryRun 应计出制品删除，实际 ${JSON.stringify(dry.deleted)}`);

  const before = dry.deleted.artifacts;
  const real = await sweepTenant(tenantA.id, { dryRun: false });
  assert.equal(real.deleted.artifacts, before);

  const gone = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/0.0.1`, adminKeyA);
  assert.equal(gone.status, 404);
  assert.ok(!existsSync(oldBlobAbs), '被清扫版本的 blob 文件应删除');
  const keptPin = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/0.0.2`, adminKeyA);
  assert.equal(keptPin.status, 200);
  const keptRel = await api('GET', `${pkgBase(pA1.id)}/${pkgA.id}/versions/0.0.3`, adminKeyA);
  assert.equal(keptRel.status, 200);
});

test('包级 retention_days=0 覆盖：当天版本也被清扫（0 天=删光已有）', async () => {
  const r = await api('POST', pkgBase(pA1.id), adminKeyA, { body: { name: 'tmp/ephemeral', kind: 'binary' } });
  const pkg = r.json.data;
  await api('PATCH', `${pkgBase(pA1.id)}/${pkg.id}`, adminKeyA, { body: { retention_days: 0 } });
  const v = await api('POST', `${pkgBase(pA1.id)}/${pkg.id}/versions`, adminKeyA, {
    rawBody: Buffer.from('ephemeral'), query: '?version=1.0.0',
  });
  assert.equal(v.status, 201);
  const sw = await sweepTenant(tenantA.id, { dryRun: false });
  assert.ok(sw.deleted.artifacts >= 1);
  const gone = await api('GET', `${pkgBase(pA1.id)}/${pkg.id}/versions/1.0.0`, adminKeyA);
  assert.equal(gone.status, 404);
});

test('删包级联：版本行/links 清空，blob 按引用清理', async () => {
  const r = await api('POST', pkgBase(pA1.id), adminKeyA, { body: { name: 'tmp/gone', kind: 'binary' } });
  const pkg = r.json.data;
  const v = await api('POST', `${pkgBase(pA1.id)}/${pkg.id}/versions`, adminKeyA, {
    rawBody: Buffer.from('gone-bytes'), query: '?version=1.0.0',
  });
  const blobAbs = join(process.env.ARTIFACT_STORE_DIR, artStore.blobPathFor(v.json.data.content_hash));
  assert.ok(existsSync(blobAbs));
  const del = await api('DELETE', `${pkgBase(pA1.id)}/${pkg.id}`, adminKeyA);
  assert.equal(del.status, 200);
  assert.equal(del.json.data.versions, 1);
  assert.ok(!existsSync(blobAbs));
  const gone = await api('GET', `${pkgBase(pA1.id)}/${pkg.id}`, adminKeyA);
  assert.equal(gone.status, 404);
});

test('未登录 401；跨租户项目 403', async () => {
  const r = await fetch(`${base}${pkgBase(pA1.id)}`);
  assert.equal(r.status, 401);
  // B 租户 key 访问 A 租户项目
  const cross = await api('GET', pkgBase(pA1.id), adminKeyB);
  assert.equal(cross.status, 403);
});
