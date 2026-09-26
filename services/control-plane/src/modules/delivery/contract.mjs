/**
 * modules/delivery/contract.mjs —— V1.0-E 产物合同（方案 p19–p20）。
 *
 * 产物合同是"合同"不是"文本"：逐项校验 DoD 清单，输出 contract_result JSON
 * （每项 pass/fail/waived + 证据引用）。fail 项只有在 DB 里存在对应的
 * gate_exception **批准记录**时才能 waive，否则合同整体不通过。
 *
 * 防绕过（自我 review 结论）：
 * - assemblePackage 内部强制现场调用 evaluateContract，不接受外部传入的合同结果；
 * - waive 只认 status='approved' 的 gate_exceptions 记录，逐项精确匹配 key，
 *   不存在"批量豁免"或"文本声明豁免"。
 *
 * 合同项 key 与门禁缺失清单共用同一命名空间（contract.*），以便 handover 门禁
 * 直接消费合同结果、例外审批直接覆盖合同项。
 */
import { nowMs } from '../../kernel/ids.mjs';
import { tryAudit } from '../evidence/audit.mjs';
import * as store from './store.mjs';
import * as svc from './service.mjs';

/** 合同项 key（全平台唯一命名空间） */
export const CONTRACT_ITEM_KEYS = [
  'contract.ac',            // 全部 AC passed/waived（V1.0-A）
  'contract.steps.build',   // build step 最近一次 passed（V1.0-D）
  'contract.steps.test',    // test step 最近一次 passed
  'contract.steps.scan',    // scan step 最近一次 passed
  'contract.scan.severity', // 扫描无未处理的 critical/high
  'contract.reproduce',     // 独立复现一致性通过（V1.0-D）
  'contract.artifacts',     // 产物齐全：diff/test_report/scan_report（+适用时 sbom）
  'contract.pr',            // 草稿 PR 已创建（V1.0-C）
];

/** 变更包全部流水线运行上已批准的门禁例外（waive 依据的唯一来源） */
async function approvedExceptionsFor(tenantId, projectId, changePackageId) {
  const runs = await store.listPipelineRuns(tenantId, projectId, { changePackageId });
  const out = [];
  for (const r of runs) {
    out.push(...await store.listGateExceptions(tenantId, r.id, { status: 'approved' }));
  }
  return out;
}

/**
 * evaluateContract({ tenantId, projectId, changePackageId, actorId })
 * 返回 { change_package_id, evaluated_at, passed, items:[{key,status,evidence,message,waived_by}] }。
 * 评估结论落库到 dod_checklist.contract（供 handover 门禁读取），并写审计事件。
 */
export async function evaluateContract({ tenantId, projectId, changePackageId, actorId }) {
  const chg = await svc.getChangePackage(tenantId, projectId, changePackageId); // 归属校验
  const items = [];
  const push = (key, status, evidence, message) =>
    items.push({ key, status, evidence: evidence ?? null, message, waived_by: null });

  // ---- contract.ac：全部 AC passed/waived（无 AC 视为未就绪，沿用 V1.0-A 语义） ----
  // batch3 遗留修复：除包级汇总项外，逐项输出未通过的 ac:<id>，门禁例外优先用
  // 逐项申请（整包豁免 contract.ac 需显式 broadWaiver 确认，见 requestGateException）
  const req = await store.getRequirement(tenantId, chg.requirement_id).catch(() => null);
  const acs = req ? await store.listACs(tenantId, req.id) : [];
  const acOk = req ? await store.allACsAccepted(tenantId, req.id) : false;
  push('contract.ac', acOk ? 'pass' : 'fail',
    { requirement_id: chg.requirement_id, acs: acs.map((a) => ({ id: a.id, kind: a.kind, status: a.status })) },
    acOk ? `全部 ${acs.length} 个验收标准已通过/豁免`
          : (req ? `存在未通过的验收标准（${acs.filter((a) => !['passed', 'waived'].includes(a.status)).length} 项待处理）`
                 : '关联需求不存在'));
  if (!acOk && req) {
    for (const a of acs.filter((x) => !['passed', 'waived'].includes(x.status))) {
      push(`ac:${a.id}`, 'fail',
        { requirement_id: req.id, ac_status: a.status },
        `验收标准未通过（当前状态=${a.status}），可逐项申请豁免`);
    }
  }

  // ---- contract.steps.*：各 step 最近一次已完成运行必须 passed ----
  for (const step of ['build', 'test', 'scan']) {
    const latest = await store.latestFinishedRunnerRun(tenantId, chg.id, step).catch(() => null);
    const ok = !!latest && latest.status === 'passed';
    push(`contract.steps.${step}`, ok ? 'pass' : 'fail',
      latest ? { run_id: latest.id, status: latest.status, exit_code: latest.exit_code, simulated: !!latest.simulated } : null,
      ok ? `${step} 最近一次运行通过（${latest.id}）`
         : (latest ? `${step} 最近一次运行状态=${latest.status}（${latest.id}）` : `无已完成的 ${step} 运行`));
  }

  // ---- contract.scan.severity：扫描 severity 数据必须存在且 critical/high 为 0 ----
  // 数据来源是 runStep 落库的 dod_checklist.scan.severities（V1.0-D 起持久化），
  // 而非运行时重算——合同只认落库证据。
  const dod = chg.dod_checklist || {};
  const scanDod = dod.scan || {};
  const sev = scanDod.severities || null;
  if (sev && sev.critical === 0 && sev.high === 0) {
    push('contract.scan.severity', 'pass',
      { severities: sev, run_id: scanDod.runId || null }, '扫描无未处理的 critical/high 漏洞');
  } else if (sev) {
    push('contract.scan.severity', 'fail',
      { severities: sev, run_id: scanDod.runId || null },
      `扫描存在未处理的高危漏洞（critical=${sev.critical}, high=${sev.high}）`);
  } else {
    push('contract.scan.severity', 'fail',
      { run_id: scanDod.runId || null },
      '缺少扫描 severity 数据（scan step 未产出可识别的报告汇总，fail-closed）');
  }

  // ---- contract.reproduce：独立复现一致性 ----
  const rep = dod.reproduce || {};
  if (rep.passed === true) {
    push('contract.reproduce', 'pass',
      { build_run: rep.buildRunId || null, test_run: rep.testRunId || null, baseline: rep.baseline || null },
      '独立工作区复现 build+test 一致');
  } else {
    push('contract.reproduce', 'fail', null, '未完成独立复现（或复现结果不一致）');
  }

  // ---- contract.artifacts：产物齐全 ----
  const arts = await store.listArtifacts(tenantId, chg.id);
  const kinds = new Set(arts.map((a) => a.kind));
  const missingKinds = ['diff', 'test_report', 'scan_report'].filter((k) => !kinds.has(k));
  // SBOM 只在"适用"时要求：package step 已通过意味着产出了可分发产物
  if (dod.package && dod.package.passed === true && !kinds.has('sbom')) missingKinds.push('sbom（package 已通过，SBOM 适用）');
  push('contract.artifacts', missingKinds.length ? 'fail' : 'pass',
    { kinds: [...kinds], missing: missingKinds },
    missingKinds.length ? `缺失产物：${missingKinds.join('、')}` : `产物齐全（${kinds.size} 类）`);

  // ---- contract.pr：草稿 PR 已创建 ----
  const pr = await store.getActivePullRequest(tenantId, chg.id).catch(() => null);
  push('contract.pr', pr ? 'pass' : 'fail',
    pr ? { pr_id: pr.id, status: pr.status, url: pr.url || null, simulated: !!pr.simulated } : null,
    pr ? `草稿 PR 已创建（${pr.id}，状态 ${pr.status}）` : '未创建草稿 PR');

  // ---- waive：fail 项必须有对应的 approved gate_exception 记录 ----
  const fails = items.filter((i) => i.status === 'fail');
  if (fails.length) {
    const approved = await approvedExceptionsFor(tenantId, projectId, chg.id);
    for (const item of fails) {
      const cover = approved.find((g) => (g.missing_items || []).includes(item.key));
      if (cover) {
        item.status = 'waived';
        item.waived_by = cover.id;
        item.message += `（经例外审批 ${cover.id} 豁免）`;
      }
    }
  }

  const passed = items.every((i) => i.status !== 'fail');
  const result = { change_package_id: chg.id, evaluated_at: nowMs(), passed, items };
  // 落库：handover 门禁读取 dod_checklist.contract 做联动
  //（L4 业务 review：键名统一为 evaluated_at，原来 at/evaluated_at 混用）
  await store.updateDodChecklist(tenantId, chg.id, {
    contract: { passed, evaluated_at: result.evaluated_at, items },
  });
  await tryAudit({
    tenantId, projectId, actorId, action: 'delivery.contract.evaluate',
    resourceKind: 'change_package', resourceId: chg.id,
    payload: {
      passed,
      failed: items.filter((i) => i.status === 'fail').map((i) => i.key),
      waived: items.filter((i) => i.status === 'waived').map((i) => ({ key: i.key, by: i.waived_by })),
    },
  });
  return result;
}
