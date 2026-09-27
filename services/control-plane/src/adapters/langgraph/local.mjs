/**
 * adapters/langgraph/local.mjs —— 本地 StateGraph 解释器（V4.2）。
 *
 * 实现与 LangGraph StateGraph 对齐的执行语义：
 *   - 按编译图的 entry → edges 推进（条件边 via: approved/rejected 由 hitl 决议驱动）
 *   - interruptBefore(hitl 节点)：执行 hitl 节点前先中断，对应 LangGraph 的 interrupt()；
 *     调用方通过 onInterrupt 回调落库审批单并返回 { resume: false } 暂停，
 *     之后用 resumeGraph({ decisions }) 把决议值回填进来继续（对应 resume 语义）
 *   - 共享 state：每个节点输出写入 state.steps[nodeId]，并更新 state.last
 *
 * 这是"薄适配层"的本地实现：生产环境可替换为真实 @langchain/langgraph
 * 包（compileAgentDefinition 的产物可 1:1 映射为 StateGraph 定义），
 * 执行语义（节点/边/中断/恢复）保持一致。
 */
import { renderTemplate } from './graph.mjs';

const DEFAULT_MAX_STEPS = 50;

/**
 * 执行编译图。
 *
 * @param {object} compiled  compileAgentDefinition 的产物
 * @param {object} opts
 *   - input: 运行输入（对象）
 *   - initialState: 恢复执行时的 state（resume 用）
 *   - startNode: 恢复执行时的起始节点（resume 用）
 *   - decisions: { [hitlNodeId]: 'approved' | 'rejected' } 已有决议
 *   - executors: { llm: async({node, prompt, state, input}) -> {output},
 *                  tool: async({node, args, state, input}) -> {output} }
 *   - onInterrupt: async({ node, state }) -> { resume: boolean }
 *       hitl 节点且无决议时调用；返回 {resume:false} 即暂停（调用方负责落库审批单）。
 *   - onNode: async({ node, output, state }) -> void  每节点执行后回调（落库步骤记录）
 *   - maxSteps: 防无限循环上限
 *
 * @returns { status:'succeeded', state } | { status:'interrupted', atNode, state }
 *          | { status:'failed', nodeId, error, state } | { status:'cancelled', nodeId, reason, state }
 */
export async function runGraph(compiled, opts = {}) {
  const {
    input = {}, initialState = null, startNode = null,
    decisions = {}, executors = {}, onInterrupt = null, onNode = null,
    maxSteps = DEFAULT_MAX_STEPS,
  } = opts;
  if (!executors.llm || !executors.tool) {
    throw new Error('executors.llm / executors.tool 必填');
  }

  const state = initialState || { input, steps: {}, last: null };
  let current = startNode || compiled.entry;
  let steps = 0;

  const edgeAfter = (nodeId, via) =>
    compiled.edges.find((e) => e.from === nodeId && (!via || e.via === via));

  while (current) {
    if (++steps > maxSteps) {
      return { status: 'failed', nodeId: current, error: `超过最大步数 ${maxSteps}（疑似无终点循环）`, state };
    }
    const node = compiled.nodes.get(current);
    if (!node) return { status: 'failed', nodeId: current, error: `节点不存在: ${current}`, state };

    // ---- hitl 中断点（LangGraph interrupt() 语义）----
    if (node.type === 'hitl') {
      const decision = decisions[node.id];
      if (decision !== 'approved' && decision !== 'rejected') {
        if (onInterrupt) {
          const r = await onInterrupt({ node, state });
          if (r && r.resume === false) {
            return { status: 'interrupted', atNode: node.id, state };
          }
        } else {
          return { status: 'interrupted', atNode: node.id, state };
        }
        // onInterrupt 返回 resume 真但仍无决议 → 视为调用方异常，失败而非死循环
        return { status: 'failed', nodeId: node.id, error: 'hitl 节点缺少决议', state };
      }
      const via = decision === 'approved' ? 'approved' : 'rejected';
      if (onNode) await onNode({ node, output: { decision, via }, state, decision });
      state.steps[node.id] = { decision, via };
      state.last = { decision, via };
      const edge = edgeAfter(node.id, via);
      if (!edge) {
        // 拒绝/通过后无后继分支：approved 无分支 → 成功结束；rejected 无分支 → 取消
        if (via === 'approved') return { status: 'succeeded', state };
        return { status: 'cancelled', nodeId: node.id, reason: 'rejected', state };
      }
      current = edge.to;
      continue;
    }

    // ---- llm / tool 节点 ----
    let output;
    try {
      if (node.type === 'llm') {
        const prompt = renderTemplate(node.prompt, { input: state.input, steps: state.steps });
        output = await executors.llm({ node, prompt, state, input: state.input });
      } else if (node.type === 'tool') {
        const args = renderObject(node.args || {}, { input: state.input, steps: state.steps });
        output = await executors.tool({ node, args, state, input: state.input });
      }
    } catch (e) {
      return { status: 'failed', nodeId: node.id, error: e?.message || String(e), state };
    }
    state.steps[node.id] = output || {};
    state.last = output || {};
    if (onNode) await onNode({ node, output: output || {}, state });

    const edge = edgeAfter(node.id, 'next');
    current = edge ? edge.to : null;
  }
  return { status: 'succeeded', state };
}

/** resumeGraph：把决议回填后从中断点继续。state 必须是中断时返回的同一对象结构。 */
export async function resumeGraph(compiled, { state, atNode, decision, ...rest } = {}) {
  if (!state || !atNode) throw new Error('resumeGraph 需要 state 与 atNode');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('decision 必须是 approved/rejected');
  // 中断点本身尚未"执行"（中断发生在执行前），resume 时从该 hitl 节点重新进入
  return runGraph(compiled, {
    ...rest,
    input: state.input,
    initialState: state,
    startNode: atNode,
    decisions: { ...(rest.decisions || {}), [atNode]: decision },
  });
}

function renderObject(obj, ctx) {
  if (Array.isArray(obj)) return obj.map((v) => renderObject(v, ctx));
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, renderObject(v, ctx)]));
  }
  return typeof obj === 'string' ? renderTemplate(obj, ctx) : obj;
}
