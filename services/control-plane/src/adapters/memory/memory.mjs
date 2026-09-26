/**
 * adapters/memory/memory.mjs —— 记忆（Mem0 + Graphiti）外部引擎扩展点（stub）。
 *
 * 架构决策（V2.2-A，见 GOAL.md）：记忆治理（分层/可见性/TTL/遗忘/提升/审计）由控制面
 * 自研实现（src/modules/memory/，PG 真相源），向量召回走 Qdrant 派生索引（V2.2-B）。
 * 本文件是「外部记忆引擎」替换召回/管理实现时的适配器扩展点：
 * Mem0（记忆管理服务）/ Graphiti（时序知识图谱，需 Neo4j）均需 Docker 可用环境联调，
 * 在提交者环境无法验证，故不伪造一个"已对接"的薄适配层——接口先行，实现待联调。
 * 调用即抛 ADAPTER_NOT_IMPLEMENTED。不要在对外材料中宣称平台已对接 Mem0/Graphiti。
 *
 * 方案中的记忆治理要求（实现时必须满足）：
 * - 分层：工作记忆（会话内）/ 情景记忆（项目内事件）/ 语义记忆（提炼事实）；
 * - 每条记忆带 tenant_id + project_id + 可见范围（visibility），跨租户不可见；
 * - TTL 与遗忘：过期自动失效，用户可要求删除（参考 forget 语义）；
 * - 记忆不能直接成为项目事实：进入知识库/交付物前必须经"事实提升"（人工或
 *   审批确认），防幻觉记忆污染业务真相源；
 * - 审计：记忆的写入/提升/删除全部进审计链。
 *
 * interface MemoryAdapter {
 *   // 写入一条记忆（情景/语义由 kind 区分）
 *   remember({ kind: 'episodic'|'semantic', tenantId, projectId, actorId,
 *              content, visibility='project', ttlMs?, metadata? })
 *     => Promise<{ id: 'mem_…' }>
 *   // 召回：按语义相似 + 可见范围过滤
 *   recall({ tenantId, projectId, actorId, query, limit? })
 *     => Promise<Array<{ id, kind, content, score, visibility }>>
 *   // 事实提升：记忆 → 候选事实（走审批，不直接写 facts 表）
 *   promote({ tenantId, projectId, actorId, memoryId })
 *     => Promise<{ proposalId }>
 *   // 遗忘：用户要求的删除（硬删 + 审计）
 *   forget({ tenantId, actorId, memoryId, reason? })
 *     => Promise<{ deleted: true }>
 * }
 *
 * 技术选型（方案）：Mem0（记忆管理）+ Graphiti（时序知识图谱）。
 * 自研控制面只写薄适配层，不自研记忆引擎。
 */
import { Errors } from '../../kernel/errors.mjs';

const NOT_IMPL = '记忆适配器（Mem0+Graphiti）尚未实现：按本文件的 MemoryAdapter 接口实现后接入';

export function createMemoryAdapter(/* { tenantId } */) {
  throw Errors.badRequest(NOT_IMPL, { code: 'ADAPTER_NOT_IMPLEMENTED' });
}

export function getMemoryStatus() {
  return 'memory(not-implemented)';
}
