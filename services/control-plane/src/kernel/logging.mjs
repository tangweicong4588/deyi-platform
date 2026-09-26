/**
 * kernel/logging.mjs —— JSON 结构化日志，输出到 stdout。
 * 每一行都是一个 JSON 对象，含 ts / level / msg / trace_id，便于 SigNoz/ELK 采集。
 */
import { config } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.LOG_LEVEL] ?? 20;

let contextProvider = () => ({});
/** 注册一个函数，用于从当前请求取 trace_id 等字段注入日志 */
export function setLogContextProvider(fn) { contextProvider = fn; }

function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...contextProvider(),
    ...fields,
  };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};
