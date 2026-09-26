/** rebuild-qdrant 测试：fetchActiveFacts 只读 + 租户隔离（R6 数据 review 契约） */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-rbq-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op_test_token';
process.env.DEV_IDP_SECRET = 'dev_test_secret_32bytes_xxxxxxxx';
process.env.BOOTSTRAP_ENABLED = 'false';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { fetchActiveFacts } = await import('../scripts/rebuild-qdrant.mjs');

const now = Date.now();
let factsSnapshot;

before(async () => {
  await openDb();
  await migrate(db());
  for (const t of ['tA', 'tB']) {
    await db().query(
      `INSERT INTO tenants(id, name, slug, status, created_at, updated_at) VALUES (?,?,?, 'active', ?, ?)`,
      [t, t, t, now, now]);
    await db().query(
      `INSERT INTO projects(id, tenant_id, name, slug, status, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)`,
      [`p_${t}`, t, `p_${t}`, `p_${t}`, now, now]);
    await db().query(
      `INSERT INTO documents(id, tenant_id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,'ready',?,?)`,
      [`doc_${t}`, t, `p_${t}`, `doc_${t}`, now, now]);
    await db().query(
      `INSERT INTO canonical_docs(id, document_id, tenant_id, project_id, version, content, content_hash, created_at) VALUES (?,?,?,?,1,'c','h',?)`,
      [`cnd_${t}`, `doc_${t}`, t, `p_${t}`, now]);
    for (let i = 0; i < 2; i++) {
      await db().query(
        `INSERT INTO facts(id, canonical_doc_id, document_id, tenant_id, project_id, chunk_index, content, embedding_model, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`fct_${t}_${i}`, `cnd_${t}`, `doc_${t}`, t, `p_${t}`, i, `content ${t} ${i}`, 'deyi-embedding', 'active', now]);
    }
    // 被版本替代的旧 fact：重建必须跳过
    await db().query(
      `INSERT INTO facts(id, canonical_doc_id, document_id, tenant_id, project_id, chunk_index, content, embedding_model, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [`fct_${t}_old`, `cnd_${t}`, `doc_${t}`, t, `p_${t}`, 0, 'old content', 'deyi-embedding', 'superseded', now]);
  }
  factsSnapshot = await db().query(`SELECT id, tenant_id, chunk_index, content, status FROM facts ORDER BY id`);
});

test('只取 active：superseded 的旧 fact 不参与重建', async () => {
  const rows = await fetchActiveFacts('tA');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.tenant_id === 'tA'));
  assert.ok(!rows.some((r) => r.id === 'fct_tA_old'));
});

test('租户隔离：tA 的查询不返回 tB 的 facts', async () => {
  const a = await fetchActiveFacts('tA');
  const b = await fetchActiveFacts('tB');
  assert.deepEqual(a.map((r) => r.id).sort(), ['fct_tA_0', 'fct_tA_1']);
  assert.deepEqual(b.map((r) => r.id).sort(), ['fct_tB_0', 'fct_tB_1']);
  // 返回行携带重建所需的全部原始字段（id/content/document_id/project_id/chunk_index）
  for (const r of [...a, ...b]) {
    assert.ok(r.id && typeof r.content === 'string' && r.document_id && r.project_id);
    assert.ok(Number.isInteger(r.chunk_index));
  }
});

test('只读：fetchActiveFacts 不创建/修改/删除任何 fact 行', async () => {
  await fetchActiveFacts('tA');
  await fetchActiveFacts('tB');
  await fetchActiveFacts('no-such-tenant');
  const after = await db().query(`SELECT id, tenant_id, chunk_index, content, status FROM facts ORDER BY id`);
  assert.deepEqual(after, factsSnapshot, 'facts 表必须与查询前完全一致');
});

test('不存在的租户返回空数组（不报错、不串租户）', async () => {
  const rows = await fetchActiveFacts('no-such-tenant');
  assert.deepEqual(rows, []);
});
