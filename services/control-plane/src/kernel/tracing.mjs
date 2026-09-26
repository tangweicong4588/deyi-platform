/**
 * kernel/tracing.mjs —— OpenTelemetry 薄封装（自研最小实现，不过度自研）。
 *
 * - OTEL_EXPORTER_OTLP_ENDPOINT 未配置 → 全 no-op（明确标记，不静默丢数据，
 *   而是从不产生 exporter 流量）。
 * - 已配置 → 用 Node 原生 fetch 发 OTLP/HTTP(JSON) 到 <endpoint>/v1/traces，
 *   不引入重型 SDK。span 结构手写最小实现，trace_id 复用请求 ctx 的 traceId
 *  （tr_<32hex> → 32hex，符合 W3C）。
 * - 覆盖：http.server（中间件）、gateway 模型调用（网关路由内 withSpan）。
 */
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { ctx } from './context.mjs';
import { logger } from './logging.mjs';

export function isTracingEnabled() {
  return !!config.OTEL_EXPORTER_OTLP_ENDPOINT;
}

function toOtelTraceId(traceId) {
  const h = String(traceId || '').replace(/^tr_/, '');
  return /^[0-9a-f]{32}$/i.test(h) ? h.toLowerCase() : randomBytes(16).toString('hex');
}

const newSpanId = () => randomBytes(8).toString('hex');
const toNano = (ms) => String(BigInt(Math.round(ms)) * 1000000n);

let batch = [];
let flushTimer = null;

function otelValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v ?? '') };
}

async function flush() {
  if (!batch.length || !isTracingEnabled()) { batch = []; return; }
  const spans = batch.splice(0, batch.length);
  const body = {
    resourceSpans: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'deyi-control-plane' } },
        { key: 'service.version', value: { stringValue: '0.5.0' } },
      ] },
      scopeSpans: [{
        scope: { name: 'deyi.kernel.tracing' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          name: s.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: toNano(s.startMs),
          endTimeUnixNano: toNano(s.endMs),
          attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: otelValue(v) })),
          status: s.status === 'error' ? { code: 2, message: s.statusMessage || '' } : { code: 1 },
        })),
      }],
    }],
  };
  try {
    const res = await fetch(config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '') + '/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) logger.warn('tracing flush failed', { status: res.status });
  } catch (e) {
    logger.warn('tracing flush error', { err: String(e && e.message || e).slice(0, 120) });
  }
}

function scheduleFlush() {
  if (flushTimer || !isTracingEnabled()) return;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, 5000);
  flushTimer.unref();
}

function enqueue(span) {
  batch.push(span);
  if (batch.length >= 50) flush().catch(() => {});
  else scheduleFlush();
}

export function startSpan(name, attrs = {}) {
  const spanId = newSpanId();
  const traceId = toOtelTraceId(ctx().traceId);
  const startMs = Date.now();
  const span = {
    name, attrs: { ...attrs }, traceId, spanId,
    setAttr(k, v) { this.attrs[k] = v; return this; },
    end(endAttrs = {}) {
      if (this._ended) return;
      this._ended = true;
      Object.assign(this.attrs, endAttrs);
      if (!isTracingEnabled()) return; // no-op：不产生任何 exporter 流量
      enqueue({
        traceId: this.traceId, spanId: this.spanId, name: this.name,
        attrs: this.attrs, startMs, endMs: Date.now(),
        status: this.attrs['span.status'] || 'ok',
        statusMessage: this.attrs['span.status_message'] || '',
      });
    },
  };
  return span;
}

export async function withSpan(name, attrs, fn) {
  const s = startSpan(name, attrs);
  try {
    const r = await fn(s);
    s.end({ 'span.status': 'ok' });
    return r;
  } catch (e) {
    s.end({ 'span.status': 'error', 'span.status_message': String(e && e.message || e).slice(0, 200) });
    throw e;
  }
}

/** http.server 中间件：在 app.use() 注册，覆盖所有路由 */
export async function tracingMiddleware(req, res, next) {
  const s = startSpan('http.server', {
    'http.method': req.method,
    'http.target': String(req.url || '').split('?')[0],
  });
  try {
    await next();
    const c = ctx();
    s.setAttr('tenant.id', c.tenantId || '');
    s.setAttr('actor.id', c.actorId || '');
    s.setAttr('http.status_code', res.statusCode || 0);
    s.end({ 'span.status': (res.statusCode || 0) >= 500 ? 'error' : 'ok' });
  } catch (e) {
    s.end({ 'span.status': 'error', 'span.status_message': String(e && e.message || e).slice(0, 200) });
    throw e;
  }
}
