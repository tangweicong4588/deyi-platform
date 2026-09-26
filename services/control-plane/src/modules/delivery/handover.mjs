/**
 * modules/delivery/handover.mjs —— V1.0-E 变更包组装（assemble）与交接报告。
 *
 * assemblePackage：锁定变更包（verifying → ready_for_review 的前置），生成
 * manifest.json / handover.md / cost.json，三者登记为 artifacts，并把关联审计
 * 事件打包进 P7 evidence package 封存。
 *
 * 防绕过（自我 review 结论）：
 * - 组装前强制现场调用 evaluateContract()，不接受任何外部传入的合同结果；
 * - 合同未通过（存在未豁免 fail 项）→ 409 拒绝组装；
 * - 成本摘要只从 model_calls（模型）与 runner_runs（执行）各做一次聚合，
 *   不与 cost_ledger 混加，杜绝重复计算；
 * - 报告读取时重算 hash 与登记值比对，不一致 → 500（防篡改）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Errors } from '../../kernel/errors.mjs';
import { nowMs } from '../../kernel/ids.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import { db } from '../../db/index.mjs';
import { buildPackage, verifyPackage } from '../evidence/packages.mjs';
import { evaluateContract } from './contract.mjs';
import * as store from './store.mjs';
import * as svc from './service.mjs';

/** 交接产物落盘根目录（测试可经 PACKAGES_ROOT 隔离） */
export const packagesRoot = () =>
  process.env.PACKAGES_ROOT || join(process.cwd(), 'var', 'packages');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const num = (v) => Number(v) || 0;
const iso = (ms) => new Date(ms).toISOString();

/**
 * 成本摘要。单一真相源、单次聚合，绝不重复计算：
 * - 模型成本：model_calls（P7 记账铁律的真相源）按项目一次聚合；
 * - 执行成本：runner_runs 按 step 一次聚合耗时/次数。
 * cost_ledger 是 model_calls 的物化视图，不在此混加（数字一致由 P7 rollup 保证）。
 */
export async function costSummary({ tenantId, projectId, changePackageId }) {
  const mrows = await db().query(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(cost_cents),0) AS cost_cents
     FROM model_calls WHERE tenant_id=? AND project_id=? AND status='ok'`,
    [tenantId, projectId]);
  const rrows = await db().query(
    `SELECT step, COUNT(*) AS runs, COALESCE(SUM(duration_ms),0) AS duration_ms
     FROM runner_runs WHERE tenant_id=? AND change_package_id=? GROUP BY step`,
    [tenantId, changePackageId]);
  const byStep = {};
  let totalRuns = 0, totalDurationMs = 0;
  for (const r of rrows) {
    byStep[r.step] = { runs: num(r.runs), duration_ms: num(r.duration_ms) };
    totalRuns += num(r.runs);
    totalDurationMs += num(r.duration_ms);
  }
  return {
    model: {
      source: 'model_calls（P7 记账真相源，一次聚合）',
      calls: num(mrows[0] && mrows[0].calls),
      tokens: num(mrows[0] && mrows[0].tokens),
      cost_cents: num(mrows[0] && mrows[0].cost_cents),
    },
    runner: {
      source: 'runner_runs（按 step 一次聚合）',
      by_step: byStep, total_runs: totalRuns, total_duration_ms: totalDurationMs,
    },
  };
}

/** 变更包关联的审计事件 id（变更包 / runs / artifacts / PR） */
async function relatedEventIds(tenantId, chg, runs, artifacts, pr) {
  const scopeIds = [chg.id,
    ...runs.map((r) => r.id),
    ...artifacts.map((a) => a.id),
    ...(pr ? [pr.id] : [])];
  if (!scopeIds.length) return [];
  const ph = scopeIds.map(() => '?').join(',');
  const rows = await db().query(
    `SELECT id FROM audit_events WHERE tenant_id=? AND resource_id IN (${ph}) ORDER BY seq ASC`,
    [tenantId, ...scopeIds]);
  return rows.map((r) => r.id);
}

function mdTick(v) { return v == null || v === '' ? '—' : String(v); }

function buildHandoverMarkdown({ chg, req, acs, artifacts, runs, pr, contract, cost, exceptions, evidencePkg }) {
  const L = [];
  L.push(`# 交接报告：${chg.id}`);
  L.push('');
  L.push(`- 变更包：${chg.id}（状态 ${chg.status}）`);
  L.push(`- 受控分支：${mdTick(chg.branch)}　base：${mdTick(chg.base_commit)}　head：${mdTick(chg.head_commit)}`);
  L.push(`- 生成时间：${iso(nowMs())}`);
  L.push('');
  L.push('## 需求映射');
  if (req) {
    L.push(`- 需求：${req.title}（${req.id}，状态 ${req.status}，${req.kind}/${req.priority}）`);
  } else {
    L.push('- 需求：缺失（合同已据此判 fail 或 waive）');
  }
  L.push('- 验收标准：');
  if (acs.length) {
    for (const a of acs) L.push(`  - [${a.status}] ${a.then_md || a.id}（${a.id}，${a.kind}）`);
  } else L.push('  - 无');
  L.push('');
  L.push('## 文件 diff 摘要');
  const diffs = artifacts.filter((a) => a.kind === 'diff');
  if (diffs.length) {
    for (const d of diffs) L.push(`- diff 产物：${d.id}　hash=${d.content_hash}　uri=${d.uri}`);
    L.push('- 完整 diff 内容以产物为准（uri 取回），本报告不复述。');
  } else {
    L.push('- 未登记 diff 产物（如合同已 waive，见例外清单）。');
  }
  L.push('');
  L.push('## 测试结果');
  const testRun = runs.filter((r) => r.step === 'test').sort((a, b) => b.created_at - a.created_at)[0];
  L.push(testRun
    ? `- test step 最近运行：${testRun.id}　状态 ${testRun.status}　exit=${testRun.exit_code}　simulated=${!!testRun.simulated}`
    : '- 无 test 运行记录');
  for (const t of artifacts.filter((a) => a.kind === 'test_report')) {
    L.push(`- 测试报告产物：${t.id}　hash=${t.content_hash}　uri=${t.uri}`);
  }
  L.push('');
  L.push('## 扫描结果');
  const scanRun = runs.filter((r) => r.step === 'scan').sort((a, b) => b.created_at - a.created_at)[0];
  const sev = (chg.dod_checklist && chg.dod_checklist.scan && chg.dod_checklist.scan.severities) || null;
  L.push(scanRun
    ? `- scan step 最近运行：${scanRun.id}　状态 ${scanRun.status}　exit=${scanRun.exit_code}`
    : '- 无 scan 运行记录');
  L.push(sev
    ? `- severity 汇总：critical=${sev.critical} high=${sev.high} moderate=${sev.moderate || 0} low=${sev.low || 0}`
    : '- severity 汇总：无数据');
  for (const s of artifacts.filter((a) => a.kind === 'scan_report')) {
    L.push(`- 扫描报告产物：${s.id}　hash=${s.content_hash}　uri=${s.uri}`);
  }
  L.push('');
  L.push('## 例外清单');
  const waived = contract.items.filter((i) => i.status === 'waived');
  if (waived.length) {
    for (const w of waived) L.push(`- 合同项 ${w.key} 经例外审批 ${w.waived_by} 豁免`);
  } else L.push('- 合同项无豁免（全部通过）');
  if (exceptions.length) {
    L.push('- 已批准的门禁例外：');
    for (const g of exceptions) {
      L.push(`  - ${g.id}（阶段 ${g.stage}，覆盖 ${(g.missing_items || []).join(', ')}，决议人 ${g.decided_by}）`);
    }
  }
  L.push('');
  L.push('## 预览地址');
  const previews = artifacts.filter((a) => a.kind === 'preview');
  if (previews.length) for (const p of previews) L.push(`- ${p.uri}（${p.id}）`);
  else L.push('- 未提供预览环境');
  L.push('');
  L.push('## 回滚说明');
  L.push('- PR 为草稿（平台禁止自批自合），未合入前回滚 = 废弃受控分支并关闭草稿 PR：');
  if (chg.branch) {
    L.push(`  - git push origin --delete ${chg.branch}（删除远端分支）`);
    L.push(`  - git branch -D ${chg.branch}（删除本地分支）`);
  }
  L.push('- 若草稿 PR 已被外部合入，回滚 = revert 合入提交：');
  if (chg.head_commit) L.push(`  - git revert ${chg.head_commit}`);
  else L.push('  - （head_commit 未记录，以远端实际合入提交为准）');
  L.push('');
  L.push('## 成本摘要');
  L.push(`- 模型调用（${cost.model.source}）：${cost.model.calls} 次，${cost.model.tokens} tokens，${cost.model.cost_cents} 分`);
  L.push(`- Runner 执行（${cost.runner.source}）：${cost.runner.total_runs} 次，总耗时 ${cost.runner.total_duration_ms} ms`);
  for (const [step, s] of Object.entries(cost.runner.by_step)) {
    L.push(`  - ${step}：${s.runs} 次，${s.duration_ms} ms`);
  }
  L.push('- 成本明细见 cost.json（与本报告同目录，hash 见产物清单）。');
  L.push('');
  L.push('## 证据包');
  if (evidencePkg) {
    L.push(`- 证据包：${evidencePkg.id}　Merkle 根 ${evidencePkg.merkle_root}　事件 ${evidencePkg.event_count} 个　验包 ${evidencePkg.verified ? '通过' : '失败'}`);
    L.push('- 验包：按 P7 证据平面验包接口重算 Merkle 根比对。');
  } else {
    L.push('- 审计事件为空，未封存证据包（assemble 不伪造空包，如实标注）。');
  }
  L.push('');
  L.push('## 产物清单');
  L.push('- manifest.json（产物清单：每个 artifact 的 content_hash + kind + uri）与 cost.json 见同目录。');
  L.push('');
  return L.join('\n');
}

/**
 * assemblePackage({ tenantId, projectId, changePackageId, actorId })
 * 前置：变更包处于 verifying；合同现场评估通过（或全部 fail 项已豁免）。
 * 产物：manifest.json / handover.md / cost.json（落盘 + 登记 artifacts）+ P7 证据包。
 */
export async function assemblePackage({ tenantId, projectId, changePackageId, actorId }) {
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  if (chg.status !== 'verifying') {
    throw Errors.conflict(`组装要求变更包处于 verifying（当前 ${chg.status}）`, { code: 'ASSEMBLE_PRECONDITION' });
  }
  // 防绕过：合同必须在这里现场评估，绝不接受外部传入的"已通过"结论
  const contract = await evaluateContract({ tenantId, projectId, changePackageId, actorId });
  if (!contract.passed) {
    throw Errors.conflict('产物合同未通过，禁止组装', {
      code: 'CONTRACT_NOT_SATISFIED',
      failed: contract.items.filter((i) => i.status === 'fail').map((i) => i.key),
    });
  }

  const req = await store.getRequirement(tenantId, chg.requirement_id).catch(() => null);
  const acs = req ? await store.listACs(tenantId, req.id) : [];
  const runs = await store.listRunnerRuns(tenantId, chg.id);
  const pr = await store.getActivePullRequest(tenantId, chg.id).catch(() => null);
  const cost = await costSummary({ tenantId, projectId, changePackageId });
  const pipeRuns = await store.listPipelineRuns(tenantId, projectId, { changePackageId: chg.id });
  const exceptions = [];
  for (const r of pipeRuns) exceptions.push(...await store.listGateExceptions(tenantId, r.id, { status: 'approved' }));

  // ---- 证据包封存（P7）：关联审计事件 → 打包 → 验包 ----
  // 注意：此时 handover/cost 产物尚未登记，事件收集基于既有 runs/artifacts/PR；
  // 证据包 id 写入 manifest，包内事件快照可独立验签。
  const preArtifacts = await store.listArtifacts(tenantId, chg.id);
  const eventIds = await relatedEventIds(tenantId, chg, runs, preArtifacts, pr);
  let evidencePkg = null;
  if (eventIds.length) {
    const built = await buildPackage({
      tenantId, projectId, name: `handover:${chg.id}`, eventIds, createdBy: actorId,
    });
    const verification = await verifyPackage(tenantId, built.id);
    evidencePkg = {
      id: built.id, merkle_root: built.merkle_root,
      event_count: built.event_count, verified: verification.ok,
    };
  }

  // ---- 落盘 + 登记 ----
  const dir = join(packagesRoot(), chg.id);
  mkdirSync(dir, { recursive: true });
  const handoverMd = buildHandoverMarkdown({
    chg, req, acs, artifacts: preArtifacts, runs, pr, contract, cost, exceptions, evidencePkg,
  });
  const costJson = JSON.stringify({ change_package_id: chg.id, generated_at: nowMs(), cost }, null, 2);
  writeFileSync(join(dir, 'handover.md'), handoverMd, 'utf8');
  writeFileSync(join(dir, 'cost.json'), costJson, 'utf8');

  const registerFile = async (filename, content) =>
    svc.registerArtifact(tenantId, projectId, chg.id, {
      kind: 'report', contentHash: sha256(content), uri: `package:${chg.id}/${filename}`,
    });
  const handoverArt = await registerFile('handover.md', handoverMd);
  const costArt = await registerFile('cost.json', costJson);

  // manifest：列出全部产物（含刚登记的 handover/cost）；manifest 自身不自引用
  //（hash 循环），其登记行在 artifacts 表中可查，uri=package:<id>/manifest.json。
  const allArtifacts = await store.listArtifacts(tenantId, chg.id);
  const manifestBody = {
    version: 1,
    change_package_id: chg.id,
    generated_at: nowMs(),
    generated_by: actorId || null,
    contract: { passed: contract.passed, evaluated_at: contract.evaluated_at, items: contract.items },
    artifacts: allArtifacts.map((a) => ({ id: a.id, kind: a.kind, content_hash: a.content_hash, uri: a.uri })),
    evidence_package: evidencePkg,
    _self: `本文件自身的 content_hash 见 artifacts 表 uri=package:${chg.id}/manifest.json 的登记（避免自引用 hash 循环）`,
  };
  const manifestJson = JSON.stringify(manifestBody, null, 2);
  writeFileSync(join(dir, 'manifest.json'), manifestJson, 'utf8');
  const manifestArt = await svc.registerArtifact(tenantId, projectId, chg.id, {
    kind: 'report', contentHash: sha256(manifestJson), uri: `package:${chg.id}/manifest.json`,
  });

  await tryAudit({
    tenantId, projectId, actorId, action: 'delivery.package.assemble',
    resourceKind: 'change_package', resourceId: chg.id,
    payload: {
      contract_passed: true,
      artifacts: [handoverArt.id, costArt.id, manifestArt.id],
      evidence_package: evidencePkg ? evidencePkg.id : null,
    },
  });

  return {
    change_package: await svc.getChangePackage(tenantId, projectId, chg.id),
    contract,
    manifest: manifestBody,
    manifest_path: join(dir, 'manifest.json'),
    handover_path: join(dir, 'handover.md'),
    cost_path: join(dir, 'cost.json'),
    artifacts: [handoverArt, costArt, manifestArt],
    evidence_package: evidencePkg,
    cost,
  };
}

/**
 * getHandoverReport({ tenantId, projectId, changePackageId })
 * 交接报告下载：取最新一次 assemble 的 handover.md，重算 hash 与登记值比对。
 */
export async function getHandoverReport({ tenantId, projectId, changePackageId }) {
  await svc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  const arts = await store.listArtifacts(tenantId, changePackageId);
  const targetUri = `package:${changePackageId}/handover.md`;
  const cands = arts.filter((a) => a.kind === 'report' && a.uri === targetUri);
  if (!cands.length) throw Errors.notFound('交接报告尚未生成（请先 assemble）');
  // 从新到旧逐个验 hash：并发组装可能留下同毫秒旧行，只认与落盘文件一致的最新登记
  for (let i = cands.length - 1; i >= 0; i--) {
    const art = cands[i];
    // uri 为平台生成的固定格式；仍做 basename 校验，防目录穿越
    const filename = basename(art.uri.split('/').pop());
    if (filename !== 'handover.md') continue;
    let content;
    try {
      content = readFileSync(join(packagesRoot(), changePackageId, filename), 'utf8');
    } catch {
      throw Errors.internal('交接报告文件丢失');
    }
    if (sha256(content) === art.content_hash) return { markdown: content, artifact: art };
  }
  throw Errors.internal('交接报告与登记 hash 不一致（文件可能被篡改）');
}
