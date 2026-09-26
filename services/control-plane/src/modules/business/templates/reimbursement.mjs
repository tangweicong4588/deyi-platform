/**
 * templates/reimbursement.mjs —— 报销申请场景模板。
 */
export default {
  id: 'reimbursement',
  name: '报销申请',
  description: '员工提交费用报销，创建财务报销单（中风险，需职责分离）',
  keywords: ['报销', '费用报销', 'reimburse'],
  maxAmountCents: 2000000, // 2 万元
  allowedTargets: ['finance'],
  slots: [
    { name: 'expense_item', label: '费用事项', type: 'string', required: true,
      extract: /报销[:：\s]*([^，。；,;]*?)(?:，|。|；|共|金额|合计|$)/ },
    { name: 'amount', label: '金额(元)', type: 'number', required: true,
      extract: /(\d+(?:\.\d+)?)\s*(万)?\s*元/ },
    { name: 'applicant', label: '报销人', type: 'string', required: false,
      extract: /报销人[:：\s]*([^，。；,;]+)/ },
    { name: 'approver', label: '审批人', type: 'string', required: false,
      extract: /审批人[:：\s]*([^，。；,;]+)/ },
  ],
  actions: [
    {
      tool: 'finance.reimburse',
      title: '创建报销单',
      risk: 'medium',
      args: (s) => ({
        expense_item: s.expense_item,
        amount_cents: Math.round((s.amount || 0) * 100),
        applicant: s.applicant || null,
        approver: s.approver || null,
      }),
      ontologyTerms: [
        { name: '报销单', kind: 'concept', definition: '员工就已发生费用申请偿付的业务单据' },
        { name: '费用', kind: 'concept', definition: '组织经营活动中发生的货币支出' },
      ],
      preconditions: [
        { kind: 'amount', detail: '单笔报销金额不超过 20000 元' },
        { kind: 'target', detail: '目标系统必须在允许清单 [finance] 内' },
        { kind: 'sod', detail: '报销人与审批人必须职责分离', fields: ['applicant', 'approver'] },
      ],
      effect: (s) => ({
        target_system: 'finance',
        objects: [`报销单(${(s.expense_item || '').slice(0, 40)})`],
        amount_cents: Math.round((s.amount || 0) * 100),
        reversible: true,
        compensation_tool: 'finance.reimburse.void',
      }),
    },
  ],
};
