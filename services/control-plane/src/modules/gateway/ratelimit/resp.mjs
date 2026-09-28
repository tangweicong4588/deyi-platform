/**
 * modules/gateway/ratelimit/resp.mjs —— V2.15：最小 RESP2 客户端。
 *
 * 为什么不用 `redis` npm 包：仓库以 pnpm 锁定，本机无 pnpm 可用，加依赖会破坏锁文件；
 * 限流路径只需要 EVALSHA/EVAL/PING/AUTH/QUIT 几个命令，手写约 120 行即可，
 * 零新依赖、行为完全可控。生产如需集群/哨兵等高级能力，可替换本文件的 client 工厂。
 *
 * 支持：redis://[[user]:password@]host:port[/db]（AUTH + SELECT）。
 * 只实现 RESP2 回复解析：+简单串、-错误、:整数、$批量串、*数组。
 */
import net from 'node:net';

export class RespError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RespError';
  }
}

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    const s = String(a);
    const len = Buffer.byteLength(s);
    parts.push(`$${len}\r\n${s}\r\n`);
  }
  return Buffer.from(parts.join(''), 'utf8');
}

class ReplyReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
  }
  /** 尝试解析一个完整回复；不完整返回 undefined（不消费）。 */
  tryParse() {
    const r = parseReply(this.buf, 0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r.next);
    return r.value;
  }
}

function parseReply(buf, off) {
  if (buf.length - off < 1) return null;
  const type = String.fromCharCode(buf[off]);
  const lineEnd = buf.indexOf('\r\n', off);
  if (lineEnd < 0) return null;
  const line = buf.toString('utf8', off + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === '+') return { value: line, next };
  if (type === '-') return { value: new RespError(line), next };
  if (type === ':') return { value: Number(line), next };
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return { value: null, next };
    if (buf.length - next < len + 2) return null;
    return { value: buf.toString('utf8', next, next + len), next: next + len + 2 };
  }
  if (type === '*') {
    const count = Number(line);
    if (count < 0) return { value: null, next };
    const items = [];
    let o = next;
    for (let i = 0; i < count; i++) {
      const r = parseReply(buf, o);
      if (!r) return null;
      items.push(r.value);
      o = r.next;
    }
    return { value: items, next: o };
  }
  throw new RespError(`未知 RESP 类型: ${type}`);
}

function parseRedisUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'redis:') throw new RespError(`不支持的协议: ${u.protocol}`);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 6379,
    password: u.password ? decodeURIComponent(u.password) : null,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
  };
}

/**
 * 连接 Redis。返回 { evalsha, eval, ping, close }。
 * evalsha(sha, keys, argv) / eval(script, keys, argv)：出错时抛 RespError。
 */
export async function connectResp(url, { connectTimeoutMs = 2000 } = {}) {
  const { host, port, password, db } = parseRedisUrl(url);
  const socket = net.createConnection({ host, port });
  const reader = new ReplyReader();
  let closed = false;
  const pending = []; // { resolve, reject }

  const failAll = (err) => {
    while (pending.length) pending.shift().reject(err);
  };

  socket.on('data', (chunk) => {
    reader.feed(chunk);
    for (;;) {
      let reply;
      try {
        reply = reader.tryParse();
      } catch (e) {
        failAll(e);
        return;
      }
      if (reply === undefined) break;
      const p = pending.shift();
      if (!p) continue; // 无人等待的回复，丢弃
      if (reply instanceof RespError) p.reject(reply);
      else p.resolve(reply);
    }
  });
  socket.on('error', (e) => failAll(e));
  socket.on('close', () => {
    closed = true;
    failAll(new RespError('连接已关闭'));
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.destroy();
      reject(new RespError(`连接 Redis 超时: ${host}:${port}`));
    }, connectTimeoutMs);
    socket.once('connect', () => { clearTimeout(t); resolve(); });
    socket.once('error', (e) => { clearTimeout(t); reject(e); });
  });

  const command = (...args) => new Promise((resolve, reject) => {
    if (closed) { reject(new RespError('连接已关闭')); return; }
    pending.push({ resolve, reject });
    socket.write(encodeCommand(args), (e) => {
      if (e) {
        const i = pending.findIndex((p) => p.reject === reject);
        if (i >= 0) pending.splice(i, 1);
        reject(e);
      }
    });
  });

  if (password) await command('AUTH', password);
  if (db) await command('SELECT', String(db));

  const evalArgs = (shaOrScript, keys, argv, useSha) => {
    const head = useSha ? ['EVALSHA', shaOrScript] : ['EVAL', shaOrScript];
    return command(...head, String(keys.length), ...keys, ...argv);
  };

  return {
    evalsha: (sha, keys, argv) => evalArgs(sha, keys, argv, true),
    eval: (script, keys, argv) => evalArgs(script, keys, argv, false),
    ping: () => command('PING'),
    close: async () => {
      closed = true;
      try { await command('QUIT'); } catch { /* ignore */ }
      socket.destroy();
    },
  };
}
