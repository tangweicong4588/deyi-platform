/**
 * modules/identity/passwords.mjs —— V2.10：密码哈希与策略。
 *
 * 选型说明（与路线图的偏差）：路线图写 argon2，但 argon2 需要原生模块编译，
 * 在受限/离线环境不可靠；此处用 node:crypto 内置的 scrypt（NIST 认可的内存困难 KDF，
 * 参数 N=16384/r=8/p=1/64 字节输出），零新依赖。哈希格式带版本号（scrypt$v1$…），
 * 将来可无缝引入 argon2id（v2）并在登录时渐进升级。
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { Errors } from '../../kernel/errors.mjs';

const VERSION = 'v1';
const N = 16384, R = 8, P = 1, KEYLEN = 64, SALTLEN = 16;
const MIN_LEN = 8;

/** 密码策略：长度 ≥ 8（企业可在上层收紧） */
export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < MIN_LEN) {
    throw Errors.badRequest(`密码长度至少 ${MIN_LEN} 位`);
  }
}

function scryptAsync(password, salt, n, r, p, keylen) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      err ? reject(err) : resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(SALTLEN);
  const key = await scryptAsync(password, salt, N, R, P, KEYLEN);
  return `scrypt$${VERSION}$n=${N}$r=${R}$p=${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    // scrypt$v1$n=16384$r=8$p=1$<salt>$<hash>
    if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== VERSION) return false;
    const n = Number(parts[2].slice(2)), r = Number(parts[3].slice(2)), p = Number(parts[4].slice(2));
    if (![n, r, p].every(Number.isFinite)) return false;
    const salt = Buffer.from(parts[5], 'base64');
    const want = Buffer.from(parts[6], 'base64');
    const got = await scryptAsync(password, salt, n, r, p, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
