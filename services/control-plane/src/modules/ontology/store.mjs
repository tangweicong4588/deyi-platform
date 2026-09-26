/**
* modules/ontology/store.mjs —— 本体真相源 CRUD + 版本链 + 冲突记录。
* 状态机与冲突策略在 service.mjs，这里只做数据访问（带租户隔离条件）。
*/
import { newId, nowMs, assertId} from '../../kernel/ids.mjs';
import { db} from '../../db/index.mjs';

export const KINDS = new Set(['concept', 'relation', 'attribute']);
export const STATUSES = new Set(['candidate', 'in_review', 'published', 'deprecated', 'rejected']);

/** 名称归一化：小写 + 去除所有空白（含全角空格），供冲突检测 */
export function normalizeName(name) {
return String(name || '').toLowerCase().replace(/[\s　]+/g, '');
}

const parseJson = (s, fb) => { try { return JSON.parse(s);} catch { return fb;}};
const normTerm = (r) => r && {...r, evidence: parseJson(r.evidence, [])};
const normConflict = (r) => r && {...r, resolution: r.resolution? parseJson(r.resolution, null): null};

export async function createTerm({ tenantId, projectId, name, kind, definition = '', evidence = [], supersedesId = null, createdBy}) {
const row = {
id: newId('ont'), tenant_id: tenantId, project_id: projectId,
name: String(name).trim(), name_norm: normalizeName(name), kind,
definition: String(definition || ''), status: 'candidate', version: 1,
supersedes_id: supersedesId, evidence: JSON.stringify(evidence || []),
created_by: createdBy || null, created_at: nowMs(), updated_at: nowMs(),
};
await db().query(
`INSERT INTO ontology_terms(id,tenant_id,project_id,name,name_norm,kind,definition,status,
version,supersedes_id,evidence,created_by,created_at,updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
[row.id, row.tenant_id, row.project_id, row.name, row.name_norm, row.kind, row.definition,
row.status, row.version, row.supersedes_id, row.evidence, row.created_by, row.created_at, row.updated_at]);
return normTerm(row);
}

export async function getTerm(tenantId, id) {
assertId('ont', id);
const rows = await db().query('SELECT * FROM ontology_terms WHERE id=? AND tenant_id=?', [id, tenantId]);
return normTerm(rows[0]) || null;
}

export async function listTerms(tenantId, projectId, { status, kind} = {}) {
let sql = 'SELECT * FROM ontology_terms WHERE tenant_id=? AND project_id=?';
const args = [tenantId, projectId];
if (status) { sql += ' AND status=?'; args.push(status);}
if (kind) { sql += ' AND kind=?'; args.push(kind);}
sql += ' ORDER BY updated_at DESC';
return (await db().query(sql, args)).map(normTerm);
}

/** 版本链：某术语的所有版本（按 version 升序，含自身） */
export async function versionChain(tenantId, termId) {
const term = await getTerm(tenantId, termId);
if (!term) return [];
// 找到链头（supersedes_id 为空的最早版本）
let head = term;
const seen = new Set();
while (head.supersedes_id &&!seen.has(head.id)) {
seen.add(head.id);
const prev = await getTerm(tenantId, head.supersedes_id);
if (!prev) break;
head = prev;
}
const rows = await db().query(
'SELECT * FROM ontology_terms WHERE tenant_id=? AND (id=? OR supersedes_id IS NOT NULL) ORDER BY version',
[tenantId, head.id]);
// 过滤出真正的链（沿 supersedes 链走，避免同名误收）
const chain = [];
let cur = head;
const byId = new Map(rows.map((r) => [r.id, r]));
const bySup = new Map();
for (const r of rows) if (r.supersedes_id) {
if (!bySup.has(r.supersedes_id)) bySup.set(r.supersedes_id, []);
bySup.get(r.supersedes_id).push(r);
}
while (cur) {
chain.push(normTerm(cur));
const next = (bySup.get(cur.id) || []).sort((a, b) => a.version - b.version)[0];
cur = next && byId.get(next.id);
}
return chain;
}

export async function setStatus(tenantId, id, status, extra = {}) {
await db().query('UPDATE ontology_terms SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
[status, nowMs(), id, tenantId]);
const t = await getTerm(tenantId, id);
return t && {...t,...extra};
}

/** 同项目内与给定归一化名相同的活跃术语（candidate/in_review/published），排除自身 */
export async function findSameName(tenantId, projectId, nameNorm, excludeId = null) {
const rows = await db().query(
`SELECT * FROM ontology_terms WHERE tenant_id=? AND project_id=? AND name_norm=?
AND status IN ('candidate','in_review','published') AND id!=?`,
[tenantId, projectId, nameNorm, excludeId || '']);
return rows.map(normTerm);
}

/** 同项目内定义高度重叠的活跃术语（token Jaccard ≥ 阈值），MVP 启发式 */
/** 同项目内定义高度重叠的活跃术语（字符 bigram Jaccard >= 阈值），MVP 启发式。
 *  用 bigram 而非按空白分词：中英文都可用，避免中文无空格整句成一词导致 Jaccard 失效。 */
export async function findOverlapping(tenantId, projectId, kind, definition, excludeId = null, threshold = 0.6) {
if (!definition || definition.trim().length < 8) return [];
const rows = await db().query(
`SELECT * FROM ontology_terms WHERE tenant_id=? AND project_id=? AND kind=?
AND status IN ('candidate','in_review','published') AND id!=? AND length(definition) >= 8`,
[tenantId, projectId, kind, excludeId || '']);
const bigrams = (s) => {
const t = String(s).toLowerCase().replace(/\s+/g, '');
const set = new Set();
for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
return set;
};
const a = bigrams(definition);
return rows.map(normTerm).filter((r) => {
const b = bigrams(r.definition);
if (!a.size || !b.size) return false;
let inter = 0;
for (const t of a) if (b.has(t)) inter++;
return inter / (a.size + b.size - inter) >= threshold;
}).map((r) => ({ term: r }));
}

// ---------- 冲突 ----------
export async function createConflict({ tenantId, projectId, termId, conflictingTermId, reason}) {
// 同一对术语（任一方向）已有 open 冲突则复用，不重复建
const dup = await db().query(
`SELECT * FROM ontology_conflicts WHERE tenant_id=? AND status='open'
AND ((term_id=? AND conflicting_term_id=?) OR (term_id=? AND conflicting_term_id=?))`,
[tenantId, termId, conflictingTermId, conflictingTermId, termId]);
if (dup[0]) return normConflict(dup[0]);
const row = {
id: newId('ocf'), tenant_id: tenantId, project_id: projectId,
term_id: termId, conflicting_term_id: conflictingTermId, reason,
status: 'open', resolution: null, resolved_by: null,
created_at: nowMs(), resolved_at: null,
};
await db().query(
`INSERT INTO ontology_conflicts(id,tenant_id,project_id,term_id,conflicting_term_id,
reason,status,resolution,resolved_by,created_at,resolved_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
[row.id, row.tenant_id, row.project_id, row.term_id, row.conflicting_term_id,
row.reason, row.status, row.resolution, row.resolved_by, row.created_at, row.resolved_at]);
return normConflict(row);
}

export async function getConflict(tenantId, id) {
assertId('ocf', id);
const rows = await db().query('SELECT * FROM ontology_conflicts WHERE id=? AND tenant_id=?', [id, tenantId]);
return normConflict(rows[0]) || null;
}

export async function listConflicts(tenantId, projectId, { status} = {}) {
let sql = 'SELECT * FROM ontology_conflicts WHERE tenant_id=? AND project_id=?';
const args = [tenantId, projectId];
if (status) { sql += ' AND status=?'; args.push(status);}
sql += ' ORDER BY created_at DESC';
return (await db().query(sql, args)).map(normConflict);
}

/** 某术语作为任一方涉及的 open 冲突 */
export async function openConflictsFor(tenantId, termId) {
const rows = await db().query(
`SELECT * FROM ontology_conflicts WHERE tenant_id=? AND status='open'
AND (term_id=? OR conflicting_term_id=?)`,
[tenantId, termId, termId]);
return rows.map(normConflict);
}

export async function resolveConflictRow(tenantId, id, { strategy, note, resolvedBy}) {
await db().query(
`UPDATE ontology_conflicts SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=? AND tenant_id=?`,
[JSON.stringify({ strategy, note: note || ''}), resolvedBy, nowMs(), id, tenantId]);
return getConflict(tenantId, id);
}
