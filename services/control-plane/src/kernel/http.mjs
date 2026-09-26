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
      routes.push({ method: method.toUpperCase(), re, names, handlers });
      return app;
    },
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
          if (!res.writableEnded) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '无响应' } });
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

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
