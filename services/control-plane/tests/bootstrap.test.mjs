/** bootstrap 回归测试：V2.5 后 scope 词表不再允许 '*'，bootstrap 必须能正常完成 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-test-')), 'test.db');
process.env.BOOTSTRAP_ENABLED = 'true';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const { maybeBootstrap } = await import('../src/modules/identity/bootstrap.mjs');
const store = await import('../src/modules/identity/store.mjs');
const { KEY_SCOPES } = await import('../src/modules/identity/keys.mjs');

before(async () => {
  await openDb();
  await migrate(db());
});

test('空库 bootstrap 成功：租户 + admin + 全 scope API Key', async () => {
  const out = await maybeBootstrap();
  assert.ok(out, '应返回 bootstrap 结果');
  const tenant = out.tenant;
  assert.equal(tenant.status, 'active');
  const keys = await db().query('SELECT * FROM api_keys WHERE tenant_id=?', [tenant.id]);
  assert.equal(keys.length, 1);
  const scopes = JSON.parse(keys[0].scopes || '[]');
  assert.deepEqual([...scopes].sort(), [...KEY_SCOPES].sort());
});

test('非空库 bootstrap 幂等跳过', async () => {
  const out = await maybeBootstrap();
  assert.equal(out, null);
});
