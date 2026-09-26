/** kernel 测试：ID / 错误 / 配置 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { newId, assertId } = await import('../src/kernel/ids.mjs');
const { Errors, toErrorJson, PlatformError } = await import('../src/kernel/errors.mjs');

test('newId 生成带前缀的平台 ID', () => {
  const id = newId('ten');
  assert.match(id, /^ten_[0-9a-z]{26}$/);
  assert.equal(id.length, 30);
  assert.notEqual(newId('ten'), newId('ten'));
  // 往返：自己生成的 ID 必须通过自己的校验（含全部字母表字符）
  for (let i = 0; i < 200; i++) assertId('ten', newId('ten'));
});

test('assertId 拒绝非法 ID', () => {
  assert.throws(() => assertId('ten', 'prj_xxx'), /非法/);
  assert.throws(() => assertId('ten', "ten_'; DROP TABLE"), /非法/);
  assert.equal(assertId('ten', newId('ten')).slice(0, 4), 'ten_');
});

test('toErrorJson：业务错误透出 code，未知错误不泄露', () => {
  const nf = toErrorJson(Errors.notFound('没了'));
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'NOT_FOUND');

  const internal = toErrorJson(new Error('secret stack trace'));
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error.code, 'INTERNAL');
  assert.ok(!JSON.stringify(internal.body).includes('secret'));
});

test('PlatformError 携带 status', () => {
  assert.equal(Errors.policyDenied('x').status, 403);
  assert.equal(Errors.budgetExceeded().status, 402);
  assert.ok(Errors.approvalRequired('appr_1').details.approvalId);
});
