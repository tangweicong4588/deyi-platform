/**
 * modules/knowledge/vector.mjs —— 向量索引适配器（薄）。
 *
 * - QDRANT_URL 设置 → 走 Qdrant（compose: qdrant:6333，collection: deyi_knowledge）。
 * - 不可用 → 内存 fallback（Map + 余弦相似度，仅开发/测试，状态明确标记）。
 * - Qdrant 是可重建的派生索引：point ID 由平台 fact ID 经 sha256 派生为 UUID，
 *   payload 里同时存平台 ID；业务真相永远在 DB，绝不把 point ID 当业务 ID。
 * - filter 语义两边一致：{ tenant_id, document_ids?: string[] }（ACL 预过滤在 DB 侧
 *   算出可见 document_id 列表后传入）。
 *
 * 联调状态（M-12 review 如实声明）：Qdrant live 路径尚未与真实 Qdrant 联调，
 * REST 契约基于 Qdrant API 文档推断；生产上线前必须端到端验证。
 * 重建见 scripts/rebuild-qdrant.mjs（向量索引是可重建派生数据）。
 */
import { createHash } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

const COLLECTION = 'deyi_knowledge';
let cachedStatus = config.QDRANT_URL ? 'qdrant(configured)' : 'local-index(fallback)';
let liveDim = 0; // Qdrant 侧 collection 的向量维度（ensure 时校验）

export function getVectorStatus() { return cachedStatus; }

/** point ID：平台 fact ID → 确定性 UUID（幂等 upsert，重复 ingest 不会产生重复 point） */
export function pointUuid(platformId) {
  const h = createHash('sha256').update('deyi-chunk:' + platformId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const base = () => config.QDRANT_URL.replace(/\/$/, '');

async function qfetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`qdrant ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

async function qdrantAvailable() {
  if (!config.QDRANT_URL) return false;
  try {
    await qfetch('/');
    return true;
  } catch {
    return false;
  }
}

/** 启动探测：只影响状态上报 */
export async function probeVector() {
  if (!(await qdrantAvailable())) {
    cachedStatus = config.QDRANT_URL ? 'qdrant(unreachable→local-index fallback)' : 'local-index(fallback)';
  } else {
    cachedStatus = 'qdrant(live)';
  }
  logger.info('vector probe', { status: cachedStatus });
  return cachedStatus;
}

async function ensureCollection(dim) {
  const info = await qfetch(`/collections/${COLLECTION}`).catch(() => null);
  if (info?.result) {
    const size = info.result?.config?.params?.vectors?.size;
    if (size && size !== dim) {
      throw new Error(`Qdrant collection 维度 ${size} 与当前 embedding 维度 ${dim} 不一致（需重建索引）`);
    }
    liveDim = size || dim;
    return;
  }
  await qfetch(`/collections/${COLLECTION}`, {
    method: 'PUT',
    body: { vectors: { size: dim, distance: 'Cosine' } },
  });
  liveDim = dim;
  logger.info('qdrant collection created', { collection: COLLECTION, dim });
}

function qdrantFilter(filter = {}) {
  const must = [];
  if (filter.tenant_id) must.push({ key: 'tenant_id', match: { value: filter.tenant_id } });
  if (filter.document_ids && filter.document_ids.length) {
    must.push({ key: 'document_id', match: { any: filter.document_ids } });
  }
  return must.length ? { must } : undefined;
}

// ---------------- 内存 fallback（开发/测试） ----------------
const memPoints = new Map(); // pointUuid -> { vector, payload }
export function clearMemoryIndex() { memPoints.clear(); }

function memMatches(payload, filter = {}) {
  if (filter.tenant_id && payload.tenant_id !== filter.tenant_id) return false;
  if (filter.document_ids && filter.document_ids.length &&
      !filter.document_ids.includes(payload.document_id)) return false;
  return true;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------- 统一接口 ----------------

/**
 * upsert chunks: [{ id: 平台 factId, vector: number[], payload: {tenant_id, project_id, document_id, fact_id, chunk_index} }]
 */
export async function upsertChunks(chunks) {
  if (!chunks.length) return { upserted: 0, engine: cachedStatus };
  const dim = chunks[0].vector.length;
  if (await qdrantAvailable()) {
    await ensureCollection(dim);
    const points = chunks.map((c) => ({ id: pointUuid(c.id), vector: c.vector, payload: c.payload }));
    await qfetch(`/collections/${COLLECTION}/points`, {
      method: 'PUT', body: { points },
    });
    cachedStatus = 'qdrant(live)';
    return { upserted: points.length, engine: 'qdrant' };
  }
  for (const c of chunks) memPoints.set(pointUuid(c.id), { vector: c.vector, payload: c.payload });
  return { upserted: chunks.length, engine: 'memory(fallback)' };
}

export async function deleteChunks(platformIds) {
  if (!platformIds.length) return { deleted: 0 };
  if (await qdrantAvailable()) {
    await qfetch(`/collections/${COLLECTION}/points/delete`, {
      method: 'POST', body: { points: platformIds.map(pointUuid) },
    });
    return { deleted: platformIds.length, engine: 'qdrant' };
  }
  let n = 0;
  for (const id of platformIds) if (memPoints.delete(pointUuid(id))) n++;
  return { deleted: n, engine: 'memory(fallback)' };
}

/**
 * search: { vector, filter: {tenant_id, document_ids?}, limit }
 * 返回 [{ fact_id, document_id, score }]（文本从 DB 取，Qdrant 只做召回）
 */
export async function searchChunks({ vector, filter = {}, limit = 10 }) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  if (await qdrantAvailable()) {
    const json = await qfetch(`/collections/${COLLECTION}/points/search`, {
      method: 'POST',
      body: { vector, filter: qdrantFilter(filter), limit: n, with_payload: true, with_vector: false },
    });
    return (json.result || []).map((p) => ({
      fact_id: p.payload?.fact_id,
      document_id: p.payload?.document_id,
      score: p.score,
      engine: 'qdrant',
    }));
  }
  const scored = [];
  for (const [, p] of memPoints) {
    if (!memMatches(p.payload, filter)) continue;
    if (p.vector.length !== vector.length) continue;
    scored.push({ fact_id: p.payload.fact_id, document_id: p.payload.document_id, score: cosine(vector, p.vector), engine: 'memory(fallback)' });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}
