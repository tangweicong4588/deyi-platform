/**
 * adapters/langgraph/graph.mjs —— Agent 定义编译（V4.2）。
 *
 * 把平台的 Agent 定义（JSON）编译成 StateGraph 语义的执行图：
 *   - addNode(id, executor)：llm / tool / hitl 三种节点类型
 *   - addEdge(from, to) / 条件边：hitl 节点的 on_approve / on_reject
 *   - setEntryPoint(entry)
 *   - interrupt()：hitl 节点在执行前中断，等待人工决议后 resume（见 local.mjs）
 *
 * 本文件只做"编译 + 校验"，不执行。生产环境可把编译产物原样映射到
 * 真实的 @langchain/langgraph StateGraph（节点名/边/入口/中断点一一对应）；
 * 本地用 local.mjs 的解释器执行，语义与上述映射保持一致。
 *
 * 定义 schema：
 * {
 *   "entry": "intake",
 *   "nodes": [
 *     {"id":"intake","type":"llm","name":"需求理解",
 *      "prompt":"把需求整理成要点：{{input.requirement}}","model":"deyi-default","next":"review"},
 *     {"id":"review","type":"hitl","name":"人工复核","title":"请复核需求要点",
 *      "on_approve":"publish","on_reject":"revise"},
 *     {"id":"publish","type":"tool","name":"发送通知","tool":"<toolId>","action":"send",
 *      "args":{"channel":"{{input.channel}}"},"next":null},
 *     {"id":"revise","type":"llm","name":"修订","prompt":"根据反馈修订","next":null}
 *   ]
 * }
 * 模板变量 {{input.x}} / {{steps.<nodeId>.text}} 在运行时做简单插值。
 */
import { Errors } from '../../kernel/errors.mjs';

export const NODE_TYPES = ['llm', 'tool', 'hitl'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 编译并校验定义。返回 { entry, nodes: Map(id -> node), edges: [{from,to,via}] }。
 * 校验失败抛 400。
 */
export function compileAgentDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw Errors.badRequest('definition 必须是对象');
  }
  const { entry, nodes } = def;
  if (!entry || typeof entry !== 'string') throw Errors.badRequest('definition.entry 必填');
  if (!Array.isArray(nodes) || !nodes.length) throw Errors.badRequest('definition.nodes 必须是非空数组');
  if (nodes.length > 100) throw Errors.badRequest('节点数上限 100');

  const map = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') throw Errors.badRequest('节点必须是对象');
    if (!n.id || !ID_RE.test(n.id)) throw Errors.badRequest(`节点 id 非法: ${n.id}`);
    if (map.has(n.id)) throw Errors.badRequest(`节点 id 重复: ${n.id}`);
    if (!NODE_TYPES.includes(n.type)) throw Errors.badRequest(`节点 ${n.id} 类型非法: ${n.type}`);
    map.set(n.id, { ...n });
  }
  if (!map.has(entry)) throw Errors.badRequest(`entry 指向不存在的节点: ${entry}`);

  const edges = [];
  const refOf = (n, field) => {
    const v = n[field];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || !map.has(v)) {
      throw Errors.badRequest(`节点 ${n.id} 的 ${field} 指向不存在的节点: ${v}`);
    }
    if (v === n.id) throw Errors.badRequest(`节点 ${n.id} 不能指向自己`);
    return v;
  };

  for (const n of map.values()) {
    if (n.type === 'hitl') {
      if (!n.on_approve && !n.on_reject) {
        throw Errors.badRequest(`hitl 节点 ${n.id} 至少需要 on_approve/on_reject 其一`);
      }
      const a = refOf(n, 'on_approve');
      const r = refOf(n, 'on_reject');
      if (a) edges.push({ from: n.id, to: a, via: 'approved' });
      if (r) edges.push({ from: n.id, to: r, via: 'rejected' });
      if (n.next !== undefined && n.next !== null) {
        throw Errors.badRequest(`hitl 节点 ${n.id} 不允许同时使用 next（请用 on_approve/on_reject）`);
      }
    } else {
      if (n.type === 'llm' && (!n.prompt || typeof n.prompt !== 'string')) {
        throw Errors.badRequest(`llm 节点 ${n.id} 的 prompt 必填`);
      }
      if (n.type === 'tool' && (!n.tool || typeof n.tool !== 'string')) {
        throw Errors.badRequest(`tool 节点 ${n.id} 的 tool（工具 id）必填`);
      }
      if (n.type === 'tool' && (!n.action || typeof n.action !== 'string')) {
        throw Errors.badRequest(`tool 节点 ${n.id} 的 action 必填`);
      }
      const nx = refOf(n, 'next');
      if (nx) edges.push({ from: n.id, to: nx, via: 'next' });
    }
  }

  // 环检测（DFS）：执行图必须是有向无环（hitl 分支同样参与）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...map.keys()].map((k) => [k, WHITE]));
  const visit = (id, stack) => {
    color.set(id, GRAY);
    for (const e of edges.filter((x) => x.from === id)) {
      if (color.get(e.to) === GRAY) {
        throw Errors.badRequest(`执行图存在环: ${[...stack, e.to].join(' -> ')}`);
      }
      if (color.get(e.to) === WHITE) visit(e.to, [...stack, e.to]);
    }
    color.set(id, BLACK);
  };
  visit(entry, [entry]);

  // 至少一个终点（无出边节点），否则流程永远无法 succeeded
  const hasTerminal = [...map.keys()].some((id) => !edges.some((e) => e.from === id));
  if (!hasTerminal) throw Errors.badRequest('执行图没有终点节点（至少一个节点无后继）');

  return { entry, nodes: map, edges };
}

/** 简单模板插值：{{input.x}} / {{steps.<nodeId>.text}}，缺失变量保留原样。 */
export function renderTemplate(tpl, { input = {}, steps = {} } = {}) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const parts = key.split('.');
    let cur;
    if (parts[0] === 'input') cur = input;
    else if (parts[0] === 'steps') cur = steps;
    else return m;
    for (const p of parts.slice(1)) {
      if (cur == null || typeof cur !== 'object') return m;
      cur = cur[p];
    }
    if (cur == null) return m;
    return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
  });
}
