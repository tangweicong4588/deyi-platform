/**
 * templates/purchase_request.mjs —— 采购申请场景模板。
 *
 * 模板是"规则驱动计划生成"的事实来源：关键词命中 → 槽位抽取（正则，确定性）
 * → 动作装配。LLM 只做槽位补充（plan.mjs），绝不能新增动作/工具/目标系统。
 * 金额解析支持"元/万元"；金额统一换算为分（amount_cents）进入 dry-run。
 */
export default {
  id: 'purchase_request',
  name: '采购申请',
  description: '员工提交采购需求，创建 ERP 采购订单（中风险，需职责分离）',
  keywords: ['采购', '购买', '下单', 'purchase'],
  maxAmountCents: 5000000, // 5 万元
  allowedTargets: ['erp'],
  slots: [
    { name: 'item', label: '采购物品', type: 'string', required: true,
      extract: /采购(?:申请|单)?[:：\s]*([^，。；,;]*?)(?:，|。|；|共|金额|预算|向|$)/ },
    { name: 'amount', label: '金额(元)', type: 'number', required: true,
      extract: /(\d+(?:\.\d+)?)\s*(万)?\s*元/ },
    { name: 'vendor', label: '供应商', type: 'string', required: false,
      extract: /供应商[:：\s]*([^，。；,;]+)/ },
    { name: 'requester', label: '申请人', type: 'string', required: false,
      extract: /申请人[:：\s]*([^，。；,;]+)/ },
    { name: 'approver', label: '审批人', type: 'string', required: false,
      extract: /审批人[:：\s]*([^，。；,;]+)/ },
  ],
  actions: [
    {
      tool: 'erp.purchase_order',
      title: '创建采购订单',
      risk: 'medium',
      args: (s) => ({
        item: s.item,
        amount_cents: Math.round((s.amount || 0) * 100),
        vendor: s.vendor || null,
        requester: s.requester || null,
        approver: s.approver || null,
      }),
      ontologyTerms: [
        { name: '采购订单', kind: 'concept', definition: '向供应商发出购买商品或服务的正式业务单据' },
        { name: '供应商', kind: 'concept', definition: '向本组织提供商品或服务的外部组织' },
      ],
      preconditions: [
        { kind: 'amount', detail: '单笔采购金额不超过 50000 元' },
        { kind: 'target', detail: '目标系统必须在允许清单 [erp] 内' },
        { kind: 'sod', detail: '申请人与审批人必须职责分离', fields: ['requester', 'approver'] },
      ],
      effect: (s) => ({
        target_system: 'erp',
        objects: [`采购订单(${(s.item || '').slice(0, 40)})`],
        amount_cents: Math.round((s.amount || 0) * 100),
        reversible: true,
        compensation_tool: 'erp.purchase_order.cancel',
      }),
    },
  ],
};
