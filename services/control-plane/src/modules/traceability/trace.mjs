/**
 * modules/traceability/trace.mjs —— V3.4 全链路追溯查询。
 *
 * 目标：需求 → 分支（变更包）→ 流水线 → 制品 → 发布 → 运行，一条 trace 查到底。
 * 任一环节 ID（requirement / change_package / pipeline_run / artifact /
 * artifact_package / artifact_version / release）都可作为 seed，解析出其所属
 * 变更包（hub），再收集该变更包关联的全部实体，拼出统一时间线。
 *
 * 时间线完全由实体行的时间字段派生（created_at/started_at/finished_at…），
 * 不依赖审计保留期，结论确定可复现。
 */
import { db } from '../../db/index.mjs';
import { Errors } from '../../kernel/errors.mjs';

/** seed kind → 解析到 change_package id 列表（保持输入顺序去重）。 */
const SEED_KINDS = new Set([
  'requirement',
  'change_package',
  'pipeline_run',
  'artifact',
  'artifact_package',
  'artifact_version',
  'release',
]);

async function resolveChangePackages(tenantId, projectId, seedKind, seedId) {
  if (!SEED_KINDS.has(seedKind)) {
    throw Errors.badRequest(`seed_kind 非法（可用：${[...SEED_KINDS].join(',')}）`, { code: 'INVALID_SEED_KIND' });
  }
  const q = (sql, params) => db().query(sql, params);
  switch (seedKind) {
    case 'requirement': {
      const req = (await q('SELECT id FROM requirements WHERE id=? AND tenant_id=? AND project_id=?', [seedId, tenantId, projectId]))[0];
      if (!req) throw Errors.notFound('需求不存在');
      const rows = await q(
        'SELECT id FROM change_packages WHERE tenant_id=? AND project_id=? AND requirement_id=? ORDER BY created_at',
        [tenantId, projectId, seedId],
      );
      return { seedEntity: 'requirement', changePackageIds: rows.map((r) => r.id) };
    }
    case 'change_package': {
      const row = (await q('SELECT id FROM change_packages WHERE id=? AND tenant_id=? AND project_id=?', [seedId, tenantId, projectId]))[0];
      if (!row) throw Errors.notFound('变更包不存在');
      return { seedEntity: 'change_package', changePackageIds: [seedId] };
    }
    case 'pipeline_run': {
      const row = (await q('SELECT id, change_package_id FROM pipeline_runs WHERE id=? AND tenant_id=? AND project_id=?', [seedId, tenantId, projectId]))[0];
      if (!row) throw Errors.notFound('流水线运行不存在');
      return { seedEntity: 'pipeline_run', changePackageIds: row.change_package_id ? [row.change_package_id] : [], direct: row };
    }
    case 'artifact': {
      const row = (await q('SELECT id, change_package_id FROM artifacts WHERE id=? AND tenant_id=?', [seedId, tenantId]))[0];
      if (!row) throw Errors.notFound('制品不存在');
      return { seedEntity: 'artifact', changePackageIds: row.change_package_id ? [row.change_package_id] : [], direct: row };
    }
    case 'artifact_package': {
      const pkg = (await q('SELECT id FROM artifact_packages WHERE id=? AND tenant_id=? AND project_id=?', [seedId, tenantId, projectId]))[0];
      if (!pkg) throw Errors.notFound('制品包不存在');
      const rows = await q(
        `SELECT DISTINCT al.link_id FROM artifact_links al
         JOIN artifact_versions av ON av.id = al.version_id
         WHERE al.tenant_id=? AND al.link_kind='change_package' AND av.package_id=?`,
        [tenantId, seedId],
      );
      return { seedEntity: 'artifact_package', changePackageIds: rows.map((r) => r.link_id), direct: pkg };
    }
    case 'artifact_version': {
      const ver = (await q('SELECT id, package_id FROM artifact_versions WHERE id=? AND tenant_id=?', [seedId, tenantId]))[0];
      if (!ver) throw Errors.notFound('制品版本不存在');
      const rows = await q(
        `SELECT link_id FROM artifact_links WHERE tenant_id=? AND version_id=? AND link_kind='change_package'`,
        [tenantId, seedId],
      );
      return { seedEntity: 'artifact_version', changePackageIds: rows.map((r) => r.link_id), direct: ver };
    }
    case 'release': {
      const row = (await q('SELECT id, change_package_id FROM releases WHERE id=? AND tenant_id=? AND project_id=?', [seedId, tenantId, projectId]))[0];
      if (!row) throw Errors.notFound('发布单不存在');
      return { seedEntity: 'release', changePackageIds: row.change_package_id ? [row.change_package_id] : [], direct: row };
    }
    default:
      throw Errors.badRequest('seed_kind 非法', { code: 'INVALID_SEED_KIND' });
  }
}

const pick = (row, keys) => {
  if (!row) return null;
  const o = {};
  for (const k of keys) o[k] = row[k] ?? null;
  return o;
};

/** 收集单个变更包的全链路实体。 */
async function collectChain(tenantId, projectId, changePackageId) {
  const q = (sql, params) => db().query(sql, params);
  const chg = (await q('SELECT * FROM change_packages WHERE id=? AND tenant_id=?', [changePackageId, tenantId]))[0];
  if (!chg) throw Errors.notFound('变更包不存在');

  const requirement = chg.requirement_id
    ? (await q('SELECT * FROM requirements WHERE id=? AND tenant_id=?', [chg.requirement_id, tenantId]))[0] || null
    : null;

  const pipelineRuns = await q(
    'SELECT * FROM pipeline_runs WHERE tenant_id=? AND change_package_id=? ORDER BY created_at',
    [tenantId, changePackageId],
  );

  const artifacts = await q(
    'SELECT * FROM artifacts WHERE tenant_id=? AND change_package_id=? ORDER BY created_at',
    [tenantId, changePackageId],
  );

  // V3.3 制品版本：经 artifact_links(link_kind=change_package) 关联
  const versionRows = await q(
    `SELECT av.*, ap.name AS package_name, ap.kind AS package_kind
     FROM artifact_links al
     JOIN artifact_versions av ON av.id = al.version_id
     JOIN artifact_packages ap ON ap.id = av.package_id
     WHERE al.tenant_id=? AND al.link_kind='change_package' AND al.link_id=?
     ORDER BY av.created_at`,
    [tenantId, changePackageId],
  );

  const releases = await q(
    `SELECT r.*, e.key AS environment_key, e.name AS environment_name
     FROM releases r LEFT JOIN deploy_environments e ON e.id = r.environment_id
     WHERE r.tenant_id=? AND r.project_id=? AND r.change_package_id=?
     ORDER BY r.created_at`,
    [tenantId, projectId, changePackageId],
  );
  for (const rel of releases) {
    rel.steps = await q(
      'SELECT * FROM release_steps WHERE tenant_id=? AND release_id=? ORDER BY seq',
      [tenantId, rel.id],
    );
  }

  return { requirement, changePackage: chg, pipelineRuns, artifacts, artifactVersions: versionRows, releases };
}

/** seed 本身游离（无变更包关联）时的单实体链：保留 seed 自身的创建事件。 */
async function collectSeedOnly(tenantId, projectId, seedEntity, seedId) {
  const chain = {
    requirement: null, changePackage: null, pipelineRuns: [],
    artifacts: [], artifactVersions: [], releases: [],
  };
  const q = (sql, params) => db().query(sql, params);
  if (seedEntity === 'requirement') {
    chain.requirement = (await q('SELECT * FROM requirements WHERE id=? AND tenant_id=?', [seedId, tenantId]))[0] || null;
  } else if (seedEntity === 'pipeline_run') {
    const row = (await q('SELECT * FROM pipeline_runs WHERE id=? AND tenant_id=?', [seedId, tenantId]))[0];
    if (row) chain.pipelineRuns = [row];
  } else if (seedEntity === 'artifact') {
    const row = (await q('SELECT * FROM artifacts WHERE id=? AND tenant_id=?', [seedId, tenantId]))[0];
    if (row) chain.artifacts = [row];
  } else if (seedEntity === 'release') {
    const row = (await q(
      `SELECT r.*, e.key AS environment_key, e.name AS environment_name
       FROM releases r LEFT JOIN deploy_environments e ON e.id = r.environment_id
       WHERE r.id=? AND r.tenant_id=?`, [seedId, tenantId]))[0];
    if (row) {
      row.steps = await q('SELECT * FROM release_steps WHERE tenant_id=? AND release_id=? ORDER BY seq', [tenantId, seedId]);
      chain.releases = [row];
    }
  } else if (seedEntity === 'artifact_package' || seedEntity === 'artifact_version') {
    const rows = seedEntity === 'artifact_package'
      ? await q(
        `SELECT av.*, ap.name AS package_name, ap.kind AS package_kind
         FROM artifact_versions av JOIN artifact_packages ap ON ap.id = av.package_id
         WHERE av.tenant_id=? AND av.package_id=? ORDER BY av.created_at`,
        [tenantId, seedId])
      : await q(
        `SELECT av.*, ap.name AS package_name, ap.kind AS package_kind
         FROM artifact_versions av JOIN artifact_packages ap ON ap.id = av.package_id
         WHERE av.tenant_id=? AND av.id=?`,
        [tenantId, seedId]);
    chain.artifactVersions = rows;
  }
  return chain;
}

let timelineSeq = 0;
function ev(ts, node, kind, label, refId, detail) {
  if (ts == null) return null;
  return { ts, seq: timelineSeq++, node, kind, label, ref_id: refId, detail: detail ?? null };
}

/** 由链实体派生统一时间线（按 ts, seq 稳定排序）。 */
function buildTimeline(chain) {
  timelineSeq = 0;
  const t = [];
  const push = (e) => { if (e) t.push(e); };

  const req = chain.requirement;
  if (req) {
    push(ev(req.created_at, 'requirement', 'created', `需求创建：${req.title}`, req.id, { status: req.status, kind: req.kind }));
  }
  const chg = chain.changePackage;
  if (chg) {
    push(ev(chg.created_at, 'change_package', 'created', `变更包创建：分支 ${chg.branch}`, chg.id, { status: chg.status }));
  }
  for (const run of chain.pipelineRuns) {
    push(ev(run.started_at, 'pipeline_run', 'stage_started', `流水线阶段开始：${run.stage}`, run.id, { status: run.status }));
    push(ev(run.finished_at, 'pipeline_run', 'stage_finished', `流水线阶段结束：${run.stage}（${run.status}）`, run.id, { status: run.status }));
  }
  for (const a of chain.artifacts) {
    push(ev(a.created_at, 'artifact', 'created', `制品产出：${a.kind}`, a.id, { content_hash: a.content_hash }));
  }
  for (const v of chain.artifactVersions) {
    push(ev(v.created_at, 'artifact_version', 'published',
      `制品版本发布：${v.package_name || v.package_id} ${v.version}`, v.id,
      { package_id: v.package_id, status: v.status }));
  }
  for (const r of chain.releases) {
    push(ev(r.created_at, 'release', 'created',
      `发布单创建：${r.version} → ${r.environment_name || r.environment_key || r.environment_id}`, r.id,
      { status: r.status, strategy: r.strategy }));
    if (r.updated_at && r.updated_at !== r.created_at) {
      push(ev(r.updated_at, 'release', 'status_changed', `发布单状态：${r.status}`, r.id, { status: r.status }));
    }
    for (const s of r.steps || []) {
      push(ev(s.finished_at, 'release_step', 'finished',
        `发布步骤完成：${s.label}（${s.status}）`, s.id,
        { kind: s.kind, status: s.status, release_id: r.id }));
    }
  }
  t.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return t;
}

const slimReq = (r) => pick(r, ['id', 'title', 'kind', 'status', 'priority', 'created_at', 'updated_at']);
const slimChg = (c) => pick(c, ['id', 'requirement_id', 'branch', 'base_commit', 'head_commit', 'status', 'created_at', 'updated_at']);
const slimRun = (r) => pick(r, ['id', 'stage', 'status', 'started_at', 'finished_at', 'created_at']);
const slimArt = (a) => pick(a, ['id', 'kind', 'content_hash', 'uri', 'created_at']);
const slimVer = (v) => pick(v, ['id', 'package_id', 'package_name', 'package_kind', 'version', 'content_hash', 'size_bytes', 'status', 'created_at']);
const slimStep = (s) => pick(s, ['id', 'seq', 'kind', 'label', 'status', 'started_at', 'finished_at']);
const slimRel = (r) => ({
  ...pick(r, ['id', 'environment_id', 'environment_key', 'environment_name', 'version', 'strategy', 'status', 'created_at', 'updated_at']),
  steps: (r.steps || []).map(slimStep),
});

/**
 * 全链路追溯查询。
 * @returns {{ seed: {kind,id}, chains: Array<{requirement,change_package,pipeline_runs,artifacts,artifact_versions,releases,timeline}> }}
 */
export async function buildTrace({ tenantId, projectId, seedKind, seedId }) {
  const { seedEntity, changePackageIds } = await resolveChangePackages(tenantId, projectId, seedKind, seedId);
  const seed = { kind: seedKind, id: seedId };

  if (changePackageIds.length === 0) {
    // seed 存在但游离（无变更包关联）：返回 seed 自身的单实体链
    const chain = await collectSeedOnly(tenantId, projectId, seedEntity, seedId);
    const slim = slimChain(chain);
    return { seed, chains: [{ ...slim, timeline: buildTimeline(chain) }] };
  }

  const chains = [];
  for (const chgId of changePackageIds) {
    const raw = await collectChain(tenantId, projectId, chgId);
    chains.push({ ...slimChain(raw), timeline: buildTimeline(raw) });
  }
  return { seed, chains };
}

function slimChain(raw) {
  return {
    requirement: slimReq(raw.requirement),
    change_package: slimChg(raw.changePackage),
    pipeline_runs: raw.pipelineRuns.map(slimRun),
    artifacts: raw.artifacts.map(slimArt),
    artifact_versions: raw.artifactVersions.map(slimVer),
    releases: raw.releases.map(slimRel),
  };
}

export const TRACE_SEED_KINDS = [...SEED_KINDS];
