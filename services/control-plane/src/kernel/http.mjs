/**
 * kernel/http.mjs —— 极简 HTTP 路由（node:http），只为控制面服务。
 * 支持：method + 路径参数(:id)、中间件链、JSON body、统一错误转 JSON。
 */
import { createServer } from 'node:http';
import { runWithContext, newTraceId } from './context.mjs';
import { toErrorJson, Errors } from './errors.mjs';
import { logger } from './logging.mjs';

function compilePath(path) {
  const names = [];
  const re = new RegExp('^' + path.replace(/:[a-zA-Z_]+/g, (m) => {
    names.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  return { re, names };
}

export function createApp() {
  const routes = [];
  const middlewares = [];

  const app = {
    use(fn) { middlewares.push(fn); return app; },
    route(method, path, ...handlers) {
      const { re, names } = compilePath(path);
      // V2.9：保留原始 path，供 OpenAPI 规范生成（/v1/openapi.json）
      routes.push({ method: method.toUpperCase(), path, re, names, handlers });
      return app;
    },
    /** V2.9：返回已注册路由表的浅拷贝（文档生成用） */
    routes() { return routes.slice(); },
    get(p, ...h) { return app.route('GET', p, ...h); },
    post(p, ...h) { return app.route('POST', p, ...h); },
    put(p, ...h) { return app.route('PUT', p, ...h); },
    patch(p, ...h) { return app.route('PATCH', p, ...h); },
    delete(p, ...h) { return app.route('DELETE', p, ...h); },

    async handle(req, res) {
      const traceId = req.headers['x-trace-id'] || newTraceId();
      res.setHeader('x-trace-id', traceId);
      const url = new URL(req.url, 'http://x');
      const m = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      await runWithContext({ traceId }, async () => {
        try {
          if (!m) throw Errors.notFound(`路由不存在: ${req.method} ${url.pathname}`);
          req.params = {};
          const vals = url.pathname.match(m.re).slice(1);
          m.names.forEach((n, i) => { req.params[n] = decodeURIComponent(vals[i]); });
          req.query = Object.fromEntries(url.searchParams.entries());
          req.body = await readJson(req);
          const chain = [...middlewares, ...m.handlers];
          let i = 0;
          const next = async () => { const fn = chain[i++]; if (fn) await fn(req, res, next); };
          await next();
          // V3.3：流式下载等已接管响应的处理器（headersSent 但未 writableEnded，
          // 如 pipe 中）不再补 404，否则对已发送头的响应重复写头。
          if (!res.writableEnded && !res.headersSent) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '无响应' } });
        } catch (err) {
          const { status, body } = toErrorJson(err);
          if (status >= 500) logger.error('unhandled', { err: String(err && err.stack || err) });
          sendJson(res, status, body);
        }
      });
    },

    listen(port, host) {
      const server = createServer((req, res) => app.handle(req, res));
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
  return app;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return resolve(undefined);
    // V3.3：制品上传走 application/octet-stream 原始二进制（避免 base64 膨胀）；
    // 上限由 ARTIFACT_MAX_BYTES 控制（默认 256MB），JSON 仍走 4MB 上限。
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype === 'application/octet-stream') return readRaw(req, resolve, reject);
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) { reject(Errors.badRequest('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(Errors.badRequest('非法 JSON')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, resolve, reject) {
  const limit = Number(process.env.ARTIFACT_MAX_BYTES) > 0
    ? Number(process.env.ARTIFACT_MAX_BYTES) : 256 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(Errors.badRequest('制品过大（超 ARTIFACT_MAX_BYTES）')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    buf.isRawUpload = true; // 标记：调用方用 Buffer.isBuffer 判，附加标记防误判
    resolve(buf);
  });
  req.on('error', reject);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
