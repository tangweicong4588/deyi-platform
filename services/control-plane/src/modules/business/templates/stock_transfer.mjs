/**
 * templates/stock_transfer.mjs —— 库存调拨场景模板。
 */
export default {
  id: 'stock_transfer',
  name: '库存调拨',
  description: '仓库之间调拨货品，创建 WMS 调拨单（低风险，数量边界控制）',
  keywords: ['调拨', '调货', '移库'],
  maxQuantity: 1000,
  allowedTargets: ['wms'],
  allowedWarehouses: ['华东仓', '华南仓', '华北仓', '西南仓'],
  slots: [
    { name: 'item', label: '货品', type: 'string', required: true,
      extract: /调拨[:：\s]*([^，。；,;]*?)(?:，|。|；|从|数量|$)/ },
    { name: 'quantity', label: '数量', type: 'number', required: true,
      extract: /(\d+(?:\.\d+)?)\s*(?:台|件|个|箱|只|套|份)?/ },
    { name: 'from_warehouse', label: '调出仓库', type: 'string', required: true,
      extract: /从[:：\s]*([^，。；,;到]+?)(?:调|到|往|$)/ },
    { name: 'to_warehouse', label: '调入仓库', type: 'string', required: true,
      extract: /(?:到|往)[:：\s]*([^，。；,;]+)/ },
  ],
  actions: [
    {
      tool: 'wms.stock_transfer',
      title: '创建库存调拨单',
      risk: 'low',
      args: (s) => ({
        item: s.item,
        quantity: Math.round(s.quantity || 0),
        from_warehouse: s.from_warehouse,
        to_warehouse: s.to_warehouse,
      }),
      ontologyTerms: [
        { name: '库存调拨单', kind: 'concept', definition: '记录货品在不同仓库之间转移的业务单据' },
        { name: '仓库', kind: 'concept', definition: '存放货品的物理或逻辑存储节点' },
      ],
      preconditions: [
        { kind: 'quantity', detail: '单次调拨数量不超过 1000' },
        { kind: 'target', detail: '目标系统必须在允许清单 [wms] 内' },
        { kind: 'object', detail: '调出/调入仓库必须在已知仓库清单内且不能相同' },
      ],
      effect: (s) => ({
        target_system: 'wms',
        objects: [`库存调拨单(${(s.item || '').slice(0, 40)} ${(s.from_warehouse || '').slice(0, 12)}→${(s.to_warehouse || '').slice(0, 12)})`],
        quantity: Math.round(s.quantity || 0),
        reversible: true,
        compensation_tool: 'wms.stock_transfer.reverse',
      }),
    },
  ],
};
