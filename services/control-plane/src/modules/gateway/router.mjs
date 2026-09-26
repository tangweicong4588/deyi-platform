/**
 * modules/gateway/router.mjs —— 模型路由：白名单 / 数据分级 / 费用估算。
 */
import { Errors } from '../../kernel/errors.mjs';
import { getModel } from './store.mjs';

/** 白名单解析：未知或停用模型直接 400 */
export async function resolveModel(name) {
  const m = await getModel(name);
  if (!m || m.status !== 'active') throw Errors.badRequest(`模型不在白名单或已停用: ${name}`);
  return m;
}

/** 数据分级校验（默认 internal；confidential 数据只能走允许的模型） */
export function checkDataClass(model, dataClass) {
  const dc = dataClass || 'internal';
  if (!model.data_classes.includes(dc)) {
    throw Errors.forbidden(`模型 ${model.name} 不允许处理 ${dc} 级数据`, { code: 'DATA_CLASS_DENIED' });
  }
  return dc;
}

/** 调用前费用估算（cents）：prompt 按 ~4 chars/token 粗估，completion 按 max_tokens/默认值 */
export function estimateCost(model, body, endpoint) {
  let promptChars, completionEst;
  if (endpoint === 'embeddings') {
    const input = body.input;
    promptChars = JSON.stringify(input || '').length;
    completionEst = 0;
  } else {
    promptChars = JSON.stringify(body.messages || []).length;
    const maxTokens = Number(body.max_tokens);
    completionEst = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 8192) : 1024;
  }
  const promptEst = Math.max(1, Math.ceil(promptChars / 4));
  const estimatedCents =
    Math.ceil(promptEst * model.cost_prompt_per_mtok_cents / 1e6) +
    Math.ceil(completionEst * model.cost_completion_per_mtok_cents / 1e6);
  return { promptEst, completionEst, estimatedCents, estimatedTokens: promptEst + completionEst };
}

/** 实际费用（cents，整数） */
export function calcCostCents(model, promptTokens, completionTokens) {
  return Math.round(
    (promptTokens * model.cost_prompt_per_mtok_cents +
     completionTokens * model.cost_completion_per_mtok_cents) / 1e6);
}
