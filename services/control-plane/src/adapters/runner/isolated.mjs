/**
 * adapters/runner/isolated.mjs —— 隔离 Runner（V1.0-D，方案 p19/p20/p23）。
 *
 * 定位：分层验证（单元/契约/集成/E2E/SAST/SCA/性能）的"独立复现"执行底座。
 * DoD 要求"变更包能由另一名工程师在独立 Runner 上复现"——本适配器提供
 * 沙箱执行 + 独立工作区（worktree/目录拷贝）两块能力。
 *
 * 安全设计（本阶段第一优先级，沙箱必须真实有效）：
 * 1. 永不使用 shell：全部经 execFile(argv 数组) 执行；commands 若传字符串直接拒绝。
 *    命令注入只能发生在"调用方把用户输入拼进 argv 元素"时——调用方（steps.mjs）
 *    只接受结构化命令，不做任何字符串拼接。
 * 2. 工作区 jail：每个 command 的 cwd、以及含 '/' 的 argv[0]（如 ./gradlew、
 *    node_modules/.bin/jest），必须解析后仍落在 workdir 内；'..' 逃逸、
 *    绝对路径指向 jail 外一律拒绝。不含 '/' 的 argv[0] 只走我们控制的最小 PATH。
 *    注意：这是进程级隔离——子进程内部若主动 symlink 逃逸（如 ln -s /etc x），
 *    只有容器/cgroup 能彻底防住；无容器时如实标注（见 limitsEnforced）。
 * 3. 环境变量白名单：不继承 process.env；只给最小集（PATH/HOME/LANG/LC_ALL/TZ/TMPDIR）
 *    + 调用方显式传入。PATH 固定为受控值且不可覆盖；HOME/TMPDIR 指向 jail 内。
 *    危险变量（LD_*、DYLD_*、NODE_OPTIONS、BASH_ENV/ENV、ZDOTDIR 等）直接拒绝。
 * 4. 密钥铁律：env key 疑似凭据（password/secret/token/api_key…）时，值必须为
 *    vault 引用（`vault:<name>`），明文直接 400；日志经 scrub 脱敏。
 * 5. 超时：Node 定时器 → kill(-pid, SIGKILL) 杀整个进程组；SIGKILL 不可捕获，
 *    超时必死。CPU/内存上限：有 prlimit（util-linux）时用 `prlimit --as/--cpu`
 *    前缀施加；无则只做超时杀，并**如实标注** unenforced（不撒谎）。
 * 6. 输出上限：stdout/stderr 各自按字节截断（默认 1MB），防日志炸磁盘；
 *    截断打标记，调用方落库前已知是不完整日志。
 *
 * 能力边界（M-11 review，如实声明，不夸大）：
 * - 无容器/cgroup 时是"进程级隔离"：子进程 double-fork + setsid 的孙进程可脱离
 *   进程组、逃过超时 SIGKILL；子进程也可通过 /proc、自建 socket 等侧信道与宿主交互。
 *   生产环境必须跑在容器/K8s Job 内（deploy 文档已标注），本适配器只保证：
 *   不经 shell、无 jail 外文件访问（调用方传入路径）、无危险 env、密钥不落地明文、
 *   输出有界、超时尽力杀。
 * - limitsEnforced 如实返回每条限制的 enforced/unenforced 状态，调用方（steps.mjs）
 *   把它写进 runner_run 记录，审计可查。
 *
 * 模式：
 * - live：本机隔离执行（默认）。无容器时是"进程级隔离"，生产必须用容器/K8s Job
 *  （deploy 文档已标注，见 limitsEnforced 里的 isolation 标注）。
 * - fake：内存模拟，返回 simulated:true 的确定性结果，绝不伪造真实执行。
 *   fake 下校验（jail/env/命令形状）照常执行，只有"执行"本身是模拟的。
 *
 * 配置（环境变量，动态读取以便测试切换；kernel/config.mjs 提供默认值与文档）：
 * - RUNNER_MODE=live|fake（默认 live）
 * - RUNNER_ROOT：工作区根目录（默认系统临时目录下 deyi-runner）
 * - RUNNER_DEFAULT_TIMEOUT_MS（默认 600000）
 * - RUNNER_MAX_OUTPUT_BYTES（默认 1048576，单流）
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  realpathSync, mkdirSync, writeFileSync, cpSync, rmSync, accessSync, constants, statSync,
} from 'node:fs';
import { resolve, relative, sep, isAbsolute, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Errors } from '../../kernel/errors.mjs';
import { config } from '../../kernel/config.mjs';

const MAX_COMMANDS = 32;
const MAX_ARGV_LEN = 64;

/** 调用方可控的最小 PATH：node 自身目录 + 系统目录（顺序固定，不可被 env 覆盖） */
function safePath() {
  return [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

export function currentRunnerMode() {
  const m = String(process.env.RUNNER_MODE ?? config.RUNNER_MODE ?? 'live').toLowerCase();
  return m === 'fake' ? 'fake' : 'live';
}

export function runnerRoot() {
  const r = process.env.RUNNER_ROOT || config.RUNNER_ROOT || join(tmpdir(), 'deyi-runner');
  mkdirSync(r, { recursive: true });
  return realpathSync(r);
}

function defaultTimeoutMs() {
  const v = Number(process.env.RUNNER_DEFAULT_TIMEOUT_MS ?? config.RUNNER_DEFAULT_TIMEOUT_MS ?? 600000);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 600000;
}

function defaultMaxOutputBytes() {
  const v = Number(process.env.RUNNER_MAX_OUTPUT_BYTES ?? config.RUNNER_MAX_OUTPUT_BYTES ?? 1048576);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1048576;
}

/** 日志脱敏：沿用 P6 scrub 模式（本地实现，避免 adapters 反向依赖 modules） */
const SCRUB_RES = [
  [/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer ***'],
  [/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)['"]?[^\s'",}]+/gi, '$1***'],
  [/\bsk-[A-Za-z0-9]{8,}\b/g, 'sk-***'],
  [/\bdyk_[A-Za-z0-9_-]{8,}\b/g, 'dyk_***'],
  // M-2 安全 review：脱敏面补齐常见凭据形状
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'], // AWS access key id
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, 'gh***'], // GitHub token
  [/\bxox[bpars]-[A-Za-z0-9-]{8,}\b/g, 'xox***'], // Slack token
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----***'], // PEM 私钥
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"/]+@/gi, (m) => m.replace(/:\/\/[^\s'"/]+@/, '://***@')], // 数据库 URL 中的 user:pass
];
export function scrubRunnerText(s) {
  let t = String(s || '');
  for (const [re, rep] of SCRUB_RES) t = t.replace(re, rep);
  return t;
}

/**
 * L-9 安全 review：argv 脱敏。--flag value 与 --flag=value 两种形式的值都打码，
 * 用于日志回显与结果返回（调用方/落库看到的 argv 不得含明文密钥）。
 */
const SECRET_FLAG_EQ_RE = /^(--?(?:api[_-]?key|token|secret|password)[\w-]*)=.+$/i;
const SECRET_FLAG_RE = /^--?(?:api[_-]?key|token|secret|password)[\w-]*$/i;
export function scrubArgv(argv) {
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] ?? '');
    const eq = a.match(SECRET_FLAG_EQ_RE);
    if (eq) { out.push(`${eq[1]}=***`); continue; }
    if (SECRET_FLAG_RE.test(a) && i + 1 < list.length && !String(list[i + 1]).startsWith('-')) {
      out.push(a, '***');
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** 密钥字段名模式（沿用 delivery/service.mjs 的 rejectPlaintextSecrets 语义） */
const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)/i;
const VAULT_REF_RE = /^vault:[A-Za-z0-9_.\-]{1,80}$/;

/** 危险环境变量：可劫持进程行为（预加载/自动 source/Node 启动参数） */
const ENV_DENY_RE = /^(LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|_RLD[A-Z0-9_]*|NODE_OPTIONS|BASH_ENV|ENV|ZDOTDIR|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|IFS|PS4|GLOBIGNORE)$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 沙箱自管变量，调用方不可覆盖 */
const ENV_RESERVED = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);

/**
 * jail 解析：p（相对或绝对）必须落在 root 内，否则抛 PATH_ESCAPE。
 * root 必须事先 realpath；比较用 relative，'..' 开头或绝对化即逃逸。
 */
export function resolveInWorkspace(root, p, what = '路径') {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p || '.');
  const rel = relative(root, abs);
  if (rel === '') return abs; // 恰为 root 本身
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw Errors.badRequest(`${what}逃逸出工作区`, { code: 'PATH_ESCAPE' });
  }
  return abs;
}

/** 单条命令校验：对象 + argv 字符串数组；返回解析后的 { name, argv, cwd } */
function assertCommand(cmd, root, index) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw Errors.badRequest(`commands[${index}] 必须为对象 {argv:[...]}，禁止 shell 字符串`, { code: 'SHELL_STRING_REJECTED' });
  }
  const { argv, cwd = '.', name = '' } = cmd;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV_LEN
    || !argv.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 4096)) {
    throw Errors.badRequest(`commands[${index}].argv 必须为非空字符串数组（1..${MAX_ARGV_LEN}）`, { code: 'BAD_ARGV' });
  }
  let workCwd = resolveInWorkspace(root, String(cwd), `commands[${index}].cwd`);
  try {
    // L-8：cwd 若是 symlink，解析后再验一次 jail（词法 resolve 会被链接带到 jail 外）
    const realCwd = realpathSync(workCwd);
    workCwd = resolveInWorkspace(root, relative(root, realCwd) || '.', `commands[${index}].cwd`);
  } catch { /* 不存在则 exec 时自然 ENOENT；词法检查已做 */ }
  let bin = argv[0];
  if (bin.includes('/') || bin.includes('\\')) {
    // 含路径分隔符：只允许 jail 内相对路径（如 ./gradlew）；jail 外绝对路径拒绝，
    // 调用方应改用 PATH 中的短名（沙箱 PATH 受控、可预期）。
    bin = resolveInWorkspace(root, bin, `commands[${index}].argv[0]`);
    // L-8 安全 review：symlink 必须 realpath 解析后再验 jail。
    // 原来只用 stat（跟随链接），workdir 内的 evil-link → /etc/passwd 这类链接
    // 会通过词法检查，随后在 jail 外被执行。
    let real;
    try {
      real = realpathSync(bin);
    } catch {
      throw Errors.badRequest(`commands[${index}].argv[0] 不存在: ${argv[0]}`, { code: 'BIN_NOT_FOUND' });
    }
    bin = resolveInWorkspace(root, relative(root, real) || '.', `commands[${index}].argv[0]`);
    const st = statSync(bin); // 已是解析后真实路径，无跟随歧义
    if (!st.isFile()) {
      throw Errors.badRequest(`commands[${index}].argv[0] 不是可执行文件`, { code: 'NOT_EXECUTABLE' });
    }
    try {
      accessSync(bin, constants.X_OK);
    } catch {
      throw Errors.badRequest(`commands[${index}].argv[0] 不可执行: ${argv[0]}`, { code: 'NOT_EXECUTABLE' });
    }
  }
  // 不含 '/' 的短名：执行时走沙箱 PATH 查找（execFile 自带 PATH 查找），此处不预解析
  return { name: String(name || argv[0]).slice(0, 128), argv: [bin, ...argv.slice(1)], cwd: workCwd };
}

/** 环境变量白名单构建：不继承 process.env */
function buildEnv(root, explicit) {
  const tmpDir = join(root, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const env = {
    PATH: safePath(),
    HOME: root,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
  };
  for (const [k, v] of Object.entries(explicit || {})) {
    if (!ENV_NAME_RE.test(k)) throw Errors.badRequest(`非法环境变量名: ${k}`, { code: 'BAD_ENV_NAME' });
    if (ENV_RESERVED.has(k)) {
      throw Errors.badRequest(`禁止覆盖沙箱自管环境变量: ${k}`, { code: 'ENV_DENIED' });
    }
    if (ENV_DENY_RE.test(k)) {
      throw Errors.badRequest(`禁止设置危险环境变量: ${k}`, { code: 'ENV_DENIED' });
    }
    const val = String(v ?? '');
    if (SECRET_KEY_RE.test(k) && !VAULT_REF_RE.test(val)) {
      throw Errors.badRequest(
        `环境变量 ${k} 疑似凭据，必须传 vault 引用（vault:<name>），禁止明文`, { code: 'PLAINTEXT_SECRET' });
    }
    if (val.length > 65536) throw Errors.badRequest(`环境变量 ${k} 过长`, { code: 'ENV_TOO_LONG' });
    env[k] = val;
  }
  return env;
}

/** prlimit 可用性探测（util-linux）；返回前缀或 null（无则如实标注 unenforced） */
function prlimitPrefix(limits) {
  const args = [];
  const memMb = Number(limits?.memoryMb);
  if (Number.isFinite(memMb) && memMb > 0) args.push(`--as=${Math.floor(memMb) * 1024 * 1024}`);
  const cpuMs = Number(limits?.cpuMs);
  if (Number.isFinite(cpuMs) && cpuMs > 0) args.push(`--cpu=${Math.max(1, Math.ceil(cpuMs / 1000))}`);
  if (!args.length) return { bin: null, args: [], requested: false };
  for (const p of ['/usr/bin/prlimit', '/bin/prlimit']) {
    try {
      accessSync(p, constants.X_OK);
      return { bin: p, args: [...args, '--'], requested: true };
    } catch { /* 继续找 */ }
  }
  return { bin: null, args: [], requested: true, unavailable: true };
}

function runOne({ file, args, cwd, env, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = execFile(file, args, {
        cwd, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ spawnError: String((e && e.message) || e), durationMs: Date.now() - started });
      return;
    }
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    const feed = (chunk, which) => {
      // execFile 的 pipe 在不同 Node 版本可能吐 string 或 Buffer，统一归一化
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const push = (cur, setFlag) => {
        if (cur.length >= maxBytes) { setFlag(); return cur; }
        const room = maxBytes - cur.length;
        if (buf.length > room) { setFlag(); return Buffer.concat([cur, buf.subarray(0, room)]); }
        return Buffer.concat([cur, buf]);
      };
      if (which === 'out') out = push(out, () => { outTrunc = true; });
      else err = push(err, () => { errTrunc = true; });
    };
    child.stdout.on('data', (d) => feed(d, 'out'));
    child.stderr.on('data', (d) => feed(d, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组可能已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
    }, timeoutMs);
    // 定时器不阻止进程退出（极端场景下兜底）
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ spawnError: String((e && e.message) || e), durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code, signal: signal || null, timedOut,
        stdout: out.toString('utf8'), stderr: err.toString('utf8'),
        truncated: outTrunc || errTrunc,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * M-12 安全 review：预校验（不执行）。供调用方在持久化 env/commands 之前先验证——
 * 非法输入（明文密钥、jail 逃逸、危险变量）直接抛错，不留脏数据。
 * 返回 { workdir（realpath 后）, plan（校验过的命令）, childEnv（白名单环境） }。
 */
export function prevalidateRunnerInput({ workdir, commands, env }) {
  if (!workdir || typeof workdir !== 'string') throw Errors.badRequest('workdir 必填');
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) {
    throw Errors.badRequest(`commands 必须为 1..${MAX_COMMANDS} 条命令的数组`, { code: 'BAD_COMMANDS' });
  }
  const root = runnerRoot();
  let absWorkdir;
  try {
    absWorkdir = realpathSync(workdir);
  } catch {
    throw Errors.badRequest('workdir 不存在', { code: 'WORKDIR_NOT_FOUND' });
  }
  // workdir 必须在 runnerRoot 内（防调用方把 jail 开到任意目录）
  resolveInWorkspace(root, relative(root, absWorkdir) || '.', 'workdir');

  // 先全部校验（任一非法则一条都不执行，fail-fast）；
  // 注意：命令的 cwd/argv[0] jail 以 workdir 为根（不是 runnerRoot），否则命令会跑错目录
  const plan = commands.map((c, i) => assertCommand(c, absWorkdir, i));
  const childEnv = buildEnv(absWorkdir, env);
  return { workdir: absWorkdir, plan, childEnv };
}

/**
 * execute({ workdir, commands, env, limits, mode })
 * - workdir：必须已存在，且落在 runnerRoot() 内（realpath 比较）。
 * - commands：[{ argv: [...], cwd?: '.', name?: '' }]，按序执行，首个非 passed 即停。
 * - env：显式环境变量（白名单制，不继承 process.env）。
 * - limits：{ timeoutMs（单命令）, stepTimeoutMs（step 总预算，默认 1h）,
 *           memoryMb, cpuMs（有 prlimit 时生效）, maxOutputBytes（单流） }。
 * - mode：'live' | 'fake'，缺省走 currentRunnerMode()。
 * 返回：{ ok, status, exitCode, signal, commands:[...], log（脱敏）, logTruncated,
 *         limitsEnforced:[...], durationMs, simulated }
 */
export async function execute({ workdir, commands, env, limits = {}, mode }) {
  const { workdir: absWorkdir, plan, childEnv } = prevalidateRunnerInput({ workdir, commands, env });
  const effMode = mode || currentRunnerMode();

  if (effMode === 'fake') return fakeExecute({ plan });

  const timeoutMs = Number(limits.timeoutMs) > 0 ? Math.floor(Number(limits.timeoutMs)) : defaultTimeoutMs();
  const maxBytes = Number(limits.maxOutputBytes) > 0 ? Math.floor(Number(limits.maxOutputBytes)) : defaultMaxOutputBytes();
  // step 级总预算：多命令 step 也不能无限跑（默认 1h）；每条命令取 min(单命令超时, 剩余预算)
  const stepTimeoutMs = Number(limits.stepTimeoutMs) > 0 ? Math.floor(Number(limits.stepTimeoutMs)) : 3600000;
  const stepDeadline = Date.now() + stepTimeoutMs;
  const prl = prlimitPrefix(limits);
  const limitsEnforced = [`timeout=${timeoutMs}ms/command(process-group SIGKILL)`, `step-timeout=${stepTimeoutMs}ms`,
    'isolation=process-level(no container)'];
  if (prl.requested && prl.bin) {
    if (Number(limits.memoryMb) > 0) limitsEnforced.push(`memory=${Math.floor(Number(limits.memoryMb))}MB(prlimit --as)`);
    if (Number(limits.cpuMs) > 0) limitsEnforced.push(`cpu=${Math.ceil(Number(limits.cpuMs) / 1000)}s(prlimit --cpu)`);
  } else if (prl.requested) {
    limitsEnforced.push('memory=unenforced(no prlimit)', 'cpu=unenforced(no prlimit)');
  }

  const results = [];
  const startedAll = Date.now();
  let finalStatus = 'passed';
  let finalExit = 0;
  let finalSignal = null;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const remaining = stepDeadline - Date.now();
    if (remaining <= 0) {
      // step 总预算耗尽：不再起新命令，整体记 timeout
      results.push({
        name: '(step budget exhausted)', argv: [], cwd: absWorkdir,
        exitCode: null, signal: null, timedOut: true, durationMs: 0,
        stdout: '', stderr: `step 总超时（${stepTimeoutMs}ms）已耗尽，剩余命令不再执行`, truncated: false,
      });
      finalStatus = 'timeout';
      break;
    }
    let file = p.argv[0];
    let args = p.argv.slice(1);
    if (prl.bin) { args = [...prl.args, file, ...args]; file = prl.bin; }
    const r = await runOne({ file, args, cwd: p.cwd, env: childEnv, timeoutMs: Math.min(timeoutMs, remaining), maxBytes });
    if (r.spawnError) {
      results.push({
        name: p.name, argv: scrubArgv(p.argv), cwd: p.cwd, exitCode: null, signal: null,
        timedOut: false, durationMs: r.durationMs,
        stdout: '', stderr: scrubRunnerText(r.spawnError), truncated: false, spawnError: true,
      });
      finalStatus = 'failed'; finalExit = 127;
      break;
    }
    let status = 'passed';
    if (r.timedOut) status = 'timeout';
    else if (r.signal) status = 'killed';
    else if (r.exitCode !== 0) status = 'failed';
    const truncMark = r.truncated ? `\n…[truncated: 单流输出超过 ${maxBytes} 字节，已截断]` : '';
    results.push({
      name: p.name, argv: scrubArgv(p.argv), cwd: p.cwd,
      exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut,
      durationMs: r.durationMs,
      stdout: scrubRunnerText(r.stdout) + (r.truncated ? truncMark : ''),
      stderr: scrubRunnerText(r.stderr),
      truncated: r.truncated,
    });
    if (status !== 'passed') {
      finalStatus = status;
      finalExit = r.exitCode;
      finalSignal = r.signal;
      break; // 首个非 passed 即停（标准 CI 语义），剩余命令不再执行
    }
  }
  const log = scrubRunnerText(results.map((c, i) => {
    const head = `[cmd ${i + 1}/${plan.length}] ${c.name}\n$ ${c.argv.join(' ')} (cwd: ${relative(absWorkdir, c.cwd) || '.'})`;
    const tail = `[exit=${c.exitCode} signal=${c.signal || '-'}${c.timedOut ? ' timedOut' : ''} ${c.durationMs}ms]`;
    return `${head}\n${c.stdout}${c.stderr ? `\n--- stderr ---\n${c.stderr}` : ''}\n${tail}`;
  }).join('\n\n'));
  const durationMs = Date.now() - startedAll;
  return {
    ok: finalStatus === 'passed',
    status: finalStatus,
    exitCode: finalExit,
    signal: finalSignal,
    commands: results,
    log,
    logTruncated: results.some((c) => c.truncated),
    limitsEnforced,
    durationMs,
    simulated: false,
  };
}

/** fake：内存模拟。校验照常（jail/env/argv），"执行"本身为确定性模拟结果。 */
function fakeExecute({ plan }) {
  const commands = plan.map((p) => ({
    name: p.name,
    argv: scrubArgv(p.argv),
    cwd: p.cwd,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: `[fake] ${scrubArgv(p.argv).join(' ')} (simulated — 未真实执行)`,
    stderr: '',
    truncated: false,
  }));
  const log = commands.map((c, i) =>
    `[cmd ${i + 1}/${plan.length}] [fake] ${c.name}\n${c.stdout}\n[exit=0 simulated]`).join('\n\n');
  return {
    ok: true, status: 'passed', exitCode: 0, signal: null,
    commands, log: scrubRunnerText(log), logTruncated: false,
    limitsEnforced: ['fake(simulated, no real execution)'],
    durationMs: 0, simulated: true,
  };
}

/**
 * prepareWorkspace({ source, label, timeoutMs }) —— 创建独立工作区并物化源码。
 * - source: { kind:'dir', path, ref? } | { kind:'empty' } | null
 *   - git 仓库（且 git 可用）→ `git worktree add --detach`（独立 worktree）；
 *   - 否则目录拷贝（排除 .git，避免把整个仓库历史塞进工作区）。
 * - timeoutMs：物化总超时（默认 120000ms）；M-9 数据 review：原来同步物化无超时，
 *   大目录拷贝/挂住的 git 会无限占住调用方。git 调用走 execFileSync timeout；
 *   目录拷贝在 filter 回调里检查 deadline（cpSync 本身无超时参数）。
 * - 返回 { dir, materialization: { method, source } }；dir 一定在 runnerRoot() 内。
 * "另一名工程师在独立 Runner 上复现"的技术基础：每次调用都是全新目录。
 */
export function prepareWorkspace({ source, label = '', timeoutMs = 120000 } = {}) {
  const root = runnerRoot();
  const dir = join(root, `ws_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const n = Number(timeoutMs);
  const effTimeout = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120000;
  const deadline = Date.now() + effTimeout;
  try {
    const materialization = materializeSource(dir, source, deadline);
    if (label) {
      try { writeFileSync(join(dir, '.runner-label'), `${label}\n${new Date().toISOString()}\n`); } catch { /* 忽略 */ }
    }
    return { dir, materialization };
  } catch (e) {
    // 物化失败：清掉半成品目录，不留垃圾占 slot/磁盘
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

function materializeSource(dir, source, deadline) {
  if (!source || source.kind === 'empty' || !source.path) {
    return { method: 'empty', source: null };
  }
  let src;
  try {
    src = realpathSync(source.path);
  } catch {
    throw Errors.badRequest('source.path 不存在', { code: 'SOURCE_NOT_FOUND' });
  }
  const gitTimeout = () => Math.max(1000, deadline - Date.now());
  // 优先 git worktree（真独立检出，可复现到指定 ref）
  try {
    execFileSync('git', ['-C', src, 'rev-parse', '--is-inside-work-tree'],
      { stdio: 'pipe', timeout: gitTimeout() });
    const ref = source.ref || 'HEAD';
    execFileSync('git', ['-C', src, 'worktree', 'add', '--detach', dir, ref],
      { stdio: 'pipe', timeout: gitTimeout() });
    return { method: 'git-worktree', source: { kind: 'dir', path: src, ref } };
  } catch (e) {
    if (e?.details?.code) throw e; // 平台错误直接透出
    if (e?.code === 'ETIMEDOUT') {
      throw Errors.badRequest('源码物化超时（git worktree）', { code: 'WORKSPACE_TIMEOUT' });
    }
    // 非 git 目录 → 降级为目录拷贝（方法如实记录）
  }
  cpSync(src, dir, {
    recursive: true,
    filter: (p) => {
      if (Date.now() > deadline) {
        throw Errors.badRequest('源码物化超时（目录拷贝）', { code: 'WORKSPACE_TIMEOUT' });
      }
      const base = p.slice(src.length);
      return base !== `${sep}.git` && !base.startsWith(`${sep}.git${sep}`);
    },
  });
  return { method: 'dir-copy', source: { kind: 'dir', path: src } };
}

/** cleanupWorkspace(dir)：销毁工作区（git worktree 先 unregister，防主仓库残留条目） */
export function cleanupWorkspace(dir) {
  if (!dir || typeof dir !== 'string') return;
  let abs;
  try { abs = realpathSync(dir); } catch { return; }
  const root = runnerRoot();
  try {
    resolveInWorkspace(root, relative(root, abs) || '.', 'cleanupWorkspace');
  } catch { return; } // 不在 runnerRoot 内：拒绝删除（防误删）
  try {
    // 若是 git worktree，先从主仓库注销（防主仓库残留 worktree 条目）
    let commonDir = null;
    try {
      commonDir = execFileSync('git', ['-C', abs, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { /* 非 git 工作区 */ }
    if (commonDir) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', abs],
          { stdio: 'pipe', cwd: commonDir });
      } catch { /* 注销失败则走 rm 兜底 */ }
    }
  } catch { /* 忽略，走 rm 兜底 */ }
  try { rmSync(abs, { recursive: true, force: true }); } catch { /* best-effort */ }
}
