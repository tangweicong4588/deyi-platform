/**
 * modules/knowledge/docling.mjs —— 文档解析适配器（薄）。
 *
 * - DOCLING_URL 设置 → 走 Docling 服务（compose: docling:5001）。
 * - 不可用/解析失败 → 内置降级：txt/md 直接取文本；pdf 等二进制格式明确标记失败，
 *   绝不伪造内容。
 * - 输出 CanonicalDoc 三要素：markdown 文本 + sha256 + 引擎标记。
 *
 * 注意：Docling 侧的 convert 接口约定以 docling-serve 实际版本为准；
 * 本适配器对响应做防御性解析，任何异常都走内置降级并打日志。
 */
import { createHash } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { logger } from '../../kernel/logging.mjs';

let cachedStatus = config.DOCLING_URL ? 'docling(configured)' : 'builtin(fallback)';
export function getDocParseStatus() { return cachedStatus; }

/** 启动/按需探测：只影响状态上报，不阻塞业务（业务走 parse 时的实时 try/catch） */
export async function probeDocParse() {
  if (!config.DOCLING_URL) { cachedStatus = 'builtin(fallback)'; return cachedStatus; }
  try {
    const res = await fetch(config.DOCLING_URL.replace(/\/$/, '') + '/health', {
      signal: AbortSignal.timeout(3000),
    });
    cachedStatus = res.ok ? 'docling(live)' : 'docling(unreachable→builtin fallback)';
  } catch {
    cachedStatus = 'docling(unreachable→builtin fallback)';
  }
  logger.info('docling probe', { status: cachedStatus });
  return cachedStatus;
}

async function parseViaDocling({ mime, content, filename }) {
  const res = await fetch(config.DOCLING_URL.replace(/\/$/, '') + '/v1/convert/source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sources: [{
        kind: 'raw',
        base64_content: Buffer.from(content, 'utf8').toString('base64'),
        mime_type: mime,
        filename: filename || 'upload',
      }],
      options: { to_formats: ['md'] },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`docling status ${res.status}`);
  const json = await res.json();
  const md = json?.document?.md_content || json?.document?.text_content;
  if (typeof md !== 'string' || !md) throw new Error('docling 响应缺少 markdown 内容');
  return md;
}

/** 内置降级：只处理纯文本；二进制格式明确失败 */
export function parseBuiltin({ mime, content }) {
  if (/text\/(plain|markdown)/.test(mime) || /markdown/.test(mime)) {
    return { ok: true, markdown: content, engine: 'builtin' };
  }
  return { ok: false, reason: `内置解析器不支持 ${mime}（需接入 Docling 服务）`, engine: 'builtin' };
}

export async function parseDocument({ mime = 'text/markdown', content = '', filename = '' }) {
  if (!content || !content.trim()) return { ok: false, reason: '内容为空' };
  if (config.DOCLING_URL) {
    try {
      const markdown = await parseViaDocling({ mime, content, filename });
      return { ok: true, markdown, engine: 'docling' };
    } catch (e) {
      logger.warn('docling parse failed, fallback to builtin', { err: String(e).slice(0, 200) });
    }
  }
  return parseBuiltin({ mime, content });
}

export const contentHash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
