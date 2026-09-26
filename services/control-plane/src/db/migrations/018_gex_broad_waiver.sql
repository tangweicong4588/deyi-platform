-- 018_gex_broad_waiver.sql —— batch3 遗留修复：门禁例外的整包豁免需显式确认。
-- contract.ac 是包级宽泛豁免键（一次批准可豁免整包所有 AC），之前与 ac:<id> 等价，
-- 审批人容易在不知情的情况下放行整包豁免。新增 broad_waiver 标记：申请时若缺失项
-- 含 contract.ac，必须显式 broadWaiver=true 确认；审批与审计均留痕。
ALTER TABLE gate_exceptions ADD COLUMN broad_waiver INTEGER NOT NULL DEFAULT 0;
