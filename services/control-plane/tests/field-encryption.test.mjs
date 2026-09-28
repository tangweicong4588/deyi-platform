/**
 * tests/field-encryption.test.mjs —— V2.16：敏感字段落库加密。
 * - KMS：信封格式 / 往返 / 篡改失败 / 无 key fail-closed / keyId 丢失
 * - TOTP：落库密文、读出可用、篡改后登录 401（不 500）、历史明文 lazy 迁移
 * - key 轮换：旧 key 解密 → sweep 重加密 → 下线旧 key 仍可用
 * - webhook secret：secret_enc 落库密文、发送时解密签名、不回显
 * - admin：GET status / POST rotate-sweep（operator）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

// 必须在业务模块 import 之前设置
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), 'deyi-fieldenc-')), 'test.db');
process.env.OPERATOR_TOKEN = 'op-' + randomBytes(8).toString('hex');
process.env.DEV_IDP_SECRET = 'dev-' + randomBytes(8).toString('hex');
process.env.BOOTSTRAP_ENABLED = 'false';
const KEY1 = randomBytes(32).toString('base64');
const KEY2 = randomBytes(32).toString('base64');
process.env.FIELD_ENCRYPTION_KEY = KEY1;
process.env.FIELD_ENCRYPTION_KEY_ID = 'k1';

const { openDb, db } = await import('../src/db/index.mjs');
const { migrate } = await import('../src/db/migrate.mjs');
const store = await import('../src/modules/identity/store.mjs');
const localauth = await import('../src/modules/identity/localauth.mjs');
const { totpCode } = await import('../src/modules/identity/totp.mjs');
const { kms, rotateSweep } = await import('../src/kernel/kms.mjs');
const notifySvc = await import('../src/modules/notify/service.mjs');
const { createApp } = await import('../src/kernel/http.mjs');
const { registerIdentityRoutes } = await import('../src/modules/identity/routes.mjs');

let tenant, actor, app, server, base;

async function createUser(username) {
  const { actor } = await localauth.createLocalUser(tenant.id, { username, password: 's3cure-Pass', name: username });
  return actor.id;
}

function req(path, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + path, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  await openDb();
  await migrate(db());
  tenant = await store.createTenant({ name: 'FieldEnc Tenant' });
  actor = await store.createActor(tenant.id, { kind: 'user', name: 'enc-admin' });
  await store.bindRole(tenant.id, actor.id, null, 'admin');
  app = createApp();
  registerIdentityRoutes(app);
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

// ---------- KMS 单元 ----------

test('kms：信封格式与往返', () => {
  const env = kms.encrypt('hello-secret');
  assert.ok(env.startsWith('enc:v1:k1:'), '信封带版本与 keyId');
  assert.equal(kms.decrypt(env), 'hello-secret');
  assert.ok(kms.isEncrypted(env));
  assert.ok(!kms.isEncrypted('plaintext'));
  assert.ok(!kms.isEncrypted(null));
});

test('kms：篡改后解密失败（GCM 认证）', () => {
  const env = kms.encrypt('tamper-me');
  const parts = env.split('.');
  const tampered = parts[0] + '.' + (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1);
  assert.throws(() => kms.decrypt(tampered), (e) => e.details?.code === 'FIELD_DECRYPT_FAILED');
});

test('kms：非法信封解密失败', () => {
  assert.throws(() => kms.decrypt('not-an-envelope'), (e) => e.details?.code === 'FIELD_DECRYPT_FAILED');
});

test('kms：无 key 时加密 fail-closed（503，不落明文）', () => {
  const saved = process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY;
  try {
    assert.throws(() => kms.encrypt('x'), (e) => e.status === 503 && e.details?.code === 'FIELD_ENCRYPTION_UNCONFIGURED');
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = saved;
  }
});

test('kms：kekId 丢失时解密报 key 缺失（不静默）', () => {
  const env = kms.encrypt('needs-old-key');
  const savedId = process.env.FIELD_ENCRYPTION_KEY_ID;
  const savedKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY_ID = 'other';
  process.env.FIELD_ENCRYPTION_KEY = KEY2;
  try {
    assert.throws(() => kms.decrypt(env), (e) => e.details?.code === 'FIELD_ENCRYPTION_KEY_MISSING');
  } finally {
    process.env.FIELD_ENCRYPTION_KEY_ID = savedId;
    process.env.FIELD_ENCRYPTION_KEY = savedKey;
  }
});

test('kms：KMS_PROVIDER 非 local 显式 NOT_IMPLEMENTED', () => {
  process.env.KMS_PROVIDER = 'aws';
  try {
    assert.throws(() => kms.encrypt('x'), (e) => /尚未实现/.test(e.message));
  } finally {
    delete process.env.KMS_PROVIDER;
  }
});

// ---------- TOTP 落库加密 ----------

test('totp：setup 落库为密文、读出可用', async () => {
  const actorId = await createUser('encuser1');
  const { secret } = await localauth.setupTotp(tenant.id, actorId);
  const row = (await db().query(
    'SELECT totp_secret, totp_secret_enc FROM local_credentials WHERE actor_id=?', [actorId]))[0];
  assert.equal(row.totp_secret, null, '明文列必须清空');
  assert.ok(row.totp_secret_enc.startsWith('enc:v1:k1:'), '密文列为信封格式');
  assert.ok(!row.totp_secret_enc.includes(secret), '密文不含明文');
  // 读出可用：enable + 登录
  await localauth.enableTotp(tenant.id, actorId, totpCode(secret));
  const lr = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser1', password: 's3cure-Pass', totpCode: totpCode(secret) });
  assert.ok(lr.accessToken, '解密后登录成功');
});

test('totp：篡改密文后登录 401（不 500、不泄露）', async () => {
  const actorId = await createUser('encuser2');
  const { secret } = await localauth.setupTotp(tenant.id, actorId);
  await localauth.enableTotp(tenant.id, actorId, totpCode(secret));
  const row = (await db().query('SELECT totp_secret_enc FROM local_credentials WHERE actor_id=?', [actorId]))[0];
  const bad = row.totp_secret_enc.slice(0, -4) + 'AAAA';
  await db().run('UPDATE local_credentials SET totp_secret_enc=? WHERE actor_id=?', [bad, actorId]);
  await assert.rejects(
    localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser2', password: 's3cure-Pass', totpCode: totpCode(secret) }),
    (e) => e.status === 401,
  );
  // 恢复后登录成功（证明只是密文被篡改）
  await db().run('UPDATE local_credentials SET totp_secret_enc=? WHERE actor_id=?', [row.totp_secret_enc, actorId]);
  const lr = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser2', password: 's3cure-Pass', totpCode: totpCode(secret) });
  assert.ok(lr.accessToken);
});

test('totp：历史明文字段 lazy 迁移', async () => {
  const actorId = await createUser('encuser3');
  const legacySecret = 'JBSWY3DPEHPK3PXP'; // 固定测试向量
  await db().run('UPDATE local_credentials SET totp_secret=?, totp_secret_enc=NULL, totp_enabled=1 WHERE actor_id=?',
    [legacySecret, actorId]);
  // 登录触发 lazy 迁移
  const lr = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser3', password: 's3cure-Pass', totpCode: totpCode(legacySecret) });
  assert.ok(lr.accessToken, '旧明文登录仍可用');
  const row = (await db().query('SELECT totp_secret, totp_secret_enc FROM local_credentials WHERE actor_id=?', [actorId]))[0];
  assert.equal(row.totp_secret, null, '明文列已清空');
  assert.ok(row.totp_secret_enc.startsWith('enc:v1:'), '已迁移为密文');
  // 迁移后登录仍成功
  const lr2 = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser3', password: 's3cure-Pass', totpCode: totpCode(legacySecret) });
  assert.ok(lr2.accessToken);
});

test('totp：无 KMS key 时 setup fail-closed（503）', async () => {
  const actorId = await createUser('encuser4');
  const saved = process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY;
  try {
    await assert.rejects(localauth.setupTotp(tenant.id, actorId),
      (e) => e.status === 503 && e.details?.code === 'FIELD_ENCRYPTION_UNCONFIGURED');
    const row = (await db().query('SELECT totp_secret, totp_secret_enc FROM local_credentials WHERE actor_id=?', [actorId]))[0];
    assert.equal(row.totp_secret, null);
    assert.equal(row.totp_secret_enc, null, '失败时不落任何值');
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = saved;
  }
});

// ---------- key 轮换 ----------

test('key 轮换：旧 key 可读 → sweep → 下线旧 key 仍可用', async () => {
  const actorId = await createUser('encuser5');
  const { secret } = await localauth.setupTotp(tenant.id, actorId); // k1 加密
  await localauth.enableTotp(tenant.id, actorId, totpCode(secret));

  // 轮换到 k2：旧 key 进 PREVIOUS
  process.env.FIELD_ENCRYPTION_KEY = KEY2;
  process.env.FIELD_ENCRYPTION_KEY_ID = 'k2';
  process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = `k1:${KEY1}`;
  try {
    // 旧信封仍可解密（登录成功）
    const lr = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser5', password: 's3cure-Pass', totpCode: totpCode(secret) });
    assert.ok(lr.accessToken, '旧 key 信封仍可解密');

    // sweep：重加密为 k2
    const out = await rotateSweep(db());
    assert.ok(out.scanned >= 1);
    assert.ok(out.rotated >= 1, `应有行被轮换: ${JSON.stringify(out)}`);
    assert.equal(out.errors.length, 0);
    const row = (await db().query('SELECT totp_secret_enc FROM local_credentials WHERE actor_id=?', [actorId]))[0];
    assert.ok(row.totp_secret_enc.startsWith('enc:v1:k2:'), '已重加密为 k2');

    // 下线旧 key：仍可用
    delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
    const lr2 = await localauth.loginWithPassword({ tenant: tenant.id, username: 'encuser5', password: 's3cure-Pass', totpCode: totpCode(secret) });
    assert.ok(lr2.accessToken, '下线旧 key 后仍可用');
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = KEY1;
    process.env.FIELD_ENCRYPTION_KEY_ID = 'k1';
    delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
  }
});

// ---------- webhook secret ----------

test('webhook：secret 明文建通道 → 落库密文、发送时解密签名', async () => {
  const ch = await notifySvc.createChannel(tenant.id, {
    kind: 'webhook', name: 'enc-hook', target: 'https://example.com/hook', secret: 'wh-secret-123',
  });
  assert.equal(ch.secret_ref, null);
  assert.ok(!('secret_enc' in ch) && !('secret' in ch), '创建返回不含任何密钥材料');
  const row = (await db().query('SELECT secret_ref, secret_enc FROM notify_channels WHERE id=?', [ch.id]))[0];
  assert.equal(row.secret_ref, null);
  assert.ok(row.secret_enc.startsWith('enc:v1:'), 'secret 落库为密文');
  assert.ok(!row.secret_enc.includes('wh-secret-123'));
  // 发送时解密
  const full = (await db().query('SELECT * FROM notify_channels WHERE id=?', [ch.id]))[0];
  assert.equal(notifySvc.resolveChannelSecret(full), 'wh-secret-123');
  // 列表不回显密文
  const list = await notifySvc.listChannels(tenant.id);
  const item = list.find((x) => x.id === ch.id);
  assert.equal(item.has_secret, true);
  assert.ok(!('secret_enc' in item), '列表不含 secret_enc');
});

test('webhook：secretRef 与 secret 二选一', async () => {
  await assert.rejects(
    notifySvc.createChannel(tenant.id, { kind: 'webhook', name: 'bad-hook', target: 'https://example.com/hook', secretRef: 'env:X', secret: 'y' }),
    (e) => e.status === 400,
  );
});

test('webhook：patch.secret 更新并重新加密', async () => {
  const ch = await notifySvc.createChannel(tenant.id, {
    kind: 'webhook', name: 'enc-hook2', target: 'https://example.com/hook', secret: 'old-secret',
  });
  await notifySvc.updateChannel(tenant.id, ch.id, { secret: 'new-secret' });
  const full = (await db().query('SELECT * FROM notify_channels WHERE id=?', [ch.id]))[0];
  assert.equal(notifySvc.resolveChannelSecret(full), 'new-secret');
});

// ---------- admin API ----------

test('admin：field-keys status（operator）', async () => {
  const r = await req('/v1/admin/security/field-keys/status', { token: process.env.OPERATOR_TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.provider, 'local');
  assert.equal(r.body.data.currentKeyId, 'k1');
  assert.ok(!JSON.stringify(r.body.data).includes(KEY1), '状态不含 key 材料');
  assert.ok(r.body.data.fields.includes('local_credentials.totp_secret_enc'));
  assert.ok(r.body.data.fields.includes('notify_channels.secret_enc'));
});

test('admin：rotate-sweep（operator，需鉴权）', async () => {
  const r0 = await req('/v1/admin/security/field-keys/rotate-sweep', { method: 'POST' });
  assert.equal(r0.status, 401);
  const r = await req('/v1/admin/security/field-keys/rotate-sweep', { method: 'POST', token: process.env.OPERATOR_TOKEN });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.scanned === 'number');
  assert.ok(typeof r.body.data.rotated === 'number');
});
