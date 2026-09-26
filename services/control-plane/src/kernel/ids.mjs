/**
 * kernel/ids.mjs —— 平台 ID 是真相源。
 *
 * 规则（对应方案"禁止反向依赖"）：
 * - 所有领域对象主键由平台生成，带类型前缀：ten_ / prj_ / usr_ / key_ / doc_ /
 *   chk_ / cnc_ / rel_ / run_ / evt_ / pol_ / bdg_ / tool_ / appr_ ...
 * - 下游组件 ID（Qdrant point id、LangGraph checkpoint、LiteLLM 虚拟 key）
 *   只存放在 *_bindings 映射表里，绝不作为领域对象主键。
 */
import { randomBytes } from 'node:crypto';
import { Errors } from './errors.mjs';

const ALPHABET = '0123456789abcdefghjkmnpqrstuvwxyz'; // base32 小写，去掉易混淆字符

function rand(n) {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/** 生成平台 ID，如 newId('ten') -> 'ten_3f9a...'（26 位随机）。
 *  前缀 2–5 位小写字母（bplan_ 等 5 位前缀为 V2.0 业务域预留）。 */
export function newId(prefix) {
  if (!/^[a-z]{2,5}$/.test(prefix)) throw new Error(`非法 ID 前缀: ${prefix}`);
  return `${prefix}_${rand(26)}`;
}

/** 校验平台 ID 格式（防御性：外部输入的 ID 先过这一关）。
 *  格式非法是客户端错误 → 400，不 500。 */
export function assertId(prefix, value) {
  // 字符类直接从 ALPHABET 派生，避免手写遗漏
  const re = new RegExp(`^${prefix}_[${ALPHABET}]{26}$`);
  if (typeof value !== 'string' || !re.test(value)) {
    throw Errors.badRequest(`非法 ${prefix} ID: ${String(value).slice(0, 40)}`);
  }
  return value;
}

export const nowMs = () => Date.now();
