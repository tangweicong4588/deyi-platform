/**
 * adapters/gitea/client.mjs —— Gitea 仓库适配器（thin adapter）。
 *
 * - live：GITEA_URL 已配置且 provider=gitea → 真 Gitea REST API。
 * - fallback：未配置或 provider=local → FakeRepoClient（内存；remote_url 为本地
 *   路径 file://... 或绝对路径时走本地 git 读分支/提交，PR 仍由平台登记）。
 * - fallback 绝不伪造成功状态：所有返回都带 `simulated: true`。
 * - 硬禁令：本文件及任何实现都不提供 merge 方法；平台路由层也不提供 merge 端点。
 *   PR 只能是 draft（live 侧用 Gitea 约定的 `WIP:` 标题前缀实现草稿语义——
 *   Gitea 的 CreatePullRequestOption 没有 draft 字段，标题 WIP 前缀即草稿）。
 * - 密钥：token 只进 Authorization header；错误信息经 scrub() 脱敏。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from '../../kernel/config.mjs';
import { Errors } from '../../kernel/errors.mjs';
import { logger } from '../../kernel/logging.mjs';

export function isGiteaLive() { return !!config.GITEA_URL; }

/** 分支名白名单（防注入：dy/<chg_id> 必须过这一关；也用于 git 参数校验） */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
export function sanitizeBranchName(name) {
  const n = String(name || '');
  if (!BRANCH_RE.test(n) || n.includes('..') || n.includes('//') || n.includes('@{')
    || n.startsWith('/') || n.endsWith('/') || n.endsWith('.lock')) {
    throw Errors.badRequest(`分支名非法: ${n.slice(0, 60)}`, { code: 'INVALID_BRANCH' });
  }
  return n;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** 从 remote_url 解析 owner/repo（live 模式拼 API 路径用） */
export function parseOwnerRepo(remoteUrl) {
  const u = String(remoteUrl || '').trim();
  let m = u.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:)([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = u.match(/^([^/:\s]+)\/([^/:\s]+?)(?:\.git)?$/); // owner/repo 简写
  if (m) return { owner: m[1], repo: m[2] };
  throw Errors.badRequest(`无法从 remote_url 解析 owner/repo: ${u.slice(0, 80)}`, { code: 'INVALID_REMOTE_URL' });
}

function scrub(token, text) {
  if (!token || !text) return text;
  return String(text).split(token).join('***');
}

async function gfetch(baseUrl, token, path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const url = baseUrl.replace(/\/$/, '') + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `token ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 网络层错误：只记录路径与错误类型，不带 token
    throw Errors.upstream(`Gitea 请求失败: ${method} ${path}（${e.name || 'network'}）`, { code: 'GITEA_UNREACHABLE' });
  }
  if (!res.ok) {
    const text = scrub(token, await res.text().catch(() => ''));
    logger.warn('gitea api error', { method, path, status: res.status });
    throw Errors.upstream(`Gitea API 错误: ${method} ${path} → ${res.status} ${text.slice(0, 200)}`,
      { code: 'GITEA_API_ERROR', status: res.status });
  }
  if (res.status === 204) return null;
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------- live 实现
class GiteaLiveClient {
  constructor({ binding, token }) {
    this.binding = binding;
    this.token = token;
    this.baseUrl = config.GITEA_URL.replace(/\/$/, '');
    const { owner, repo } = parseOwnerRepo(binding.remote_url);
    this.owner = owner;
    this.repoName = repo;
    this.simulated = false;
  }
  _p(p) { return `/api/v1/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repoName)}${p}`; }
  _repoId() { return `${this.owner}/${this.repoName}`; }

  async getRepo() {
    const r = await gfetch(this.baseUrl, this.token, this._p(''));
    return {
      provider: 'gitea', repo: this._repoId(), defaultBranch: r.default_branch || this.binding.default_branch,
      private: !!r.private, url: r.html_url || this.binding.remote_url, simulated: false,
    };
  }
  async getBranchCommit(branch) {
    sanitizeBranchName(branch);
    const b = await gfetch(this.baseUrl, this.token, this._p(`/branches/${encodeURIComponent(branch)}`));
    const sha = b?.commit?.id;
    if (!sha) throw Errors.upstream(`Gitea 未返回分支提交: ${branch}`, { code: 'GITEA_BAD_RESPONSE' });
    return { branch, sha, simulated: false };
  }
  async listBranches(limit = 50) {
    const bs = await gfetch(this.baseUrl, this.token, this._p(`/branches?limit=${Math.min(limit, 50)}`));
    return (Array.isArray(bs) ? bs : []).map((b) => ({
      name: b.name, sha: b?.commit?.id || '', simulated: false,
    })).filter((b) => b.name);
  }
  async listCommits(branch, limit = 20) {
    sanitizeBranchName(branch);
    const cs = await gfetch(this.baseUrl, this.token,
      this._p(`/commits?sha=${encodeURIComponent(branch)}&limit=${Math.min(limit, 20)}`));
    return (Array.isArray(cs) ? cs : []).map((c) => ({
      sha: c.sha || '', message: String(c?.commit?.message || '').split('\n')[0].slice(0, 200),
      author: c?.commit?.author?.name || '', date: c?.commit?.author?.date || '',
    })).filter((c) => c.sha);
  }
  async createBranch({ branch, from }) {
    sanitizeBranchName(branch);
    if (!SHA_RE.test(String(from || ''))) throw Errors.badRequest('from 必须为 40 位 commit sha');
    try {
      await gfetch(this.baseUrl, this.token, this._p('/branches'),
        { method: 'POST', body: { new_branch_name: branch, create_from: from } });
    } catch (e) {
      // 409 已存在 → 幂等：确认指向同一提交则视为成功
      if (e?.details?.status === 409) {
        const cur = await this.getBranchCommit(branch).catch(() => null);
        if (cur && cur.sha.toLowerCase() === String(from).toLowerCase()) {
          return { branch, sha: cur.sha, existed: true, simulated: false };
        }
      }
      throw e;
    }
    return { branch, sha: from, simulated: false };
  }
  /**
   * 只允许 draft。Gitea 无 draft 字段，用 `WIP:` 标题前缀表达草稿（官方约定）。
   * draft !== true 直接 400，绝不创建出可直接合入的 PR。
   */
  async createDraftPull({ head, base, title, body = '', draft }) {
    if (draft !== true) {
      throw Errors.badRequest('平台只允许创建草稿 PR（draft=true），禁止创建可直接评审合入的 PR',
        { code: 'DRAFT_REQUIRED' });
    }
    sanitizeBranchName(head);
    sanitizeBranchName(base);
    const t = String(title || '').trim();
    if (!t) throw Errors.badRequest('PR title 必填');
    const wipTitle = /^(wip:|\[(wip|draft)\])/i.test(t) ? t : `WIP: ${t}`;
    const pr = await gfetch(this.baseUrl, this.token, this._p('/pulls'),
      { method: 'POST', body: { head, base, title: wipTitle, body: String(body).slice(0, 8000) } });
    const number = pr.index ?? pr.number;
    return {
      number, url: pr.html_url || '', title: pr.title || wipTitle, repo: this._repoId(),
      head, base, draft: true, status: 'draft', simulated: false,
    };
  }
  async getPullStatus(number) {
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) throw Errors.badRequest('PR number 非法');
    const pr = await gfetch(this.baseUrl, this.token, this._p(`/pulls/${n}`));
    const status = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
    return {
      number: n, status, merged: !!pr.merged, draft: !!pr.draft,
      head: pr.head?.label || pr.head?.ref || '', base: pr.base?.ref || '',
      url: pr.html_url || '', title: pr.title || '', simulated: false,
    };
  }
  async listIssues({ state = 'open', limit = 20 } = {}) {
    const is = await gfetch(this.baseUrl, this.token,
      this._p(`/issues?state=${encodeURIComponent(state)}&type=issues&limit=${Math.min(limit, 20)}`));
    return (Array.isArray(is) ? is : []).map((x) => ({
      number: x.number, title: x.title || '', state: x.state || '',
      url: x.html_url || '', labels: (x.labels || []).map((l) => l.name).filter(Boolean),
      simulated: false,
    }));
  }
  async listPulls({ state = 'open', limit = 20 } = {}) {
    const ps = await gfetch(this.baseUrl, this.token,
      this._p(`/pulls?state=${encodeURIComponent(state)}&limit=${Math.min(limit, 20)}`));
    return (Array.isArray(ps) ? ps : []).map((x) => ({
      number: x.index ?? x.number, title: x.title || '', draft: !!x.draft,
      head: x.head?.ref || '', base: x.base?.ref || '', url: x.html_url || '', simulated: false,
    }));
  }
}

// ---------------------------------------------------------------- fake 实现
const fakeState = new Map(); // remoteUrl -> { branches: Map, pulls: Map, nextPr: n, seedSha }

function fakeSha(seed) {
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 40);
}

function isLocalPath(remoteUrl) {
  const u = String(remoteUrl || '');
  return u.startsWith('file://') || u.startsWith('/');
}
function bareDirOf(remoteUrl) {
  const u = String(remoteUrl || '');
  return u.startsWith('file://') ? u.slice('file://'.length) : u;
}

/** 本地 git 调用：execFile 无 shell，分支名已过白名单；输出绝不含 token（file 协议无凭据） */
function git(bareDir, args) {
  try {
    return execFileSync('git', ['--git-dir', bareDir, ...args], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (e) {
    const msg = String(e.stderr || e.message || '').split('\n')[0].slice(0, 200);
    throw Errors.upstream(`本地 git 失败: git ${args[0]}（${msg}）`, { code: 'LOCAL_GIT_ERROR' });
  }
}

/**
 * ls-remote 必须显式传仓库路径（`git --git-dir=X ls-remote HEAD` 会把 HEAD
 * 当成远端名）。这里不用 --git-dir，直接把路径当 repository 参数。
 */
function gitLsRemote(bareDir, args) {
  try {
    return execFileSync('git', ['ls-remote', bareDir, ...args], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (e) {
    const msg = String(e.stderr || e.message || '').split('\n')[0].slice(0, 200);
    throw Errors.upstream(`本地 git 失败: git ls-remote（${msg}）`, { code: 'LOCAL_GIT_ERROR' });
  }
}

class FakeRepoClient {
  constructor({ binding }) {
    this.binding = binding;
    this.token = null; // fake 不使用凭据（resolveToken 已在上游 fail-closed 校验）
    this.simulated = true;
    this.localGit = isLocalPath(binding.remote_url);
    if (!fakeState.has(binding.remote_url)) {
      fakeState.set(binding.remote_url, {
        branches: new Map([[binding.default_branch || 'main', fakeSha(binding.remote_url)]]),
        pulls: new Map(), nextPr: 1,
      });
    }
    this.st = fakeState.get(binding.remote_url);
    // 仅测试用：模拟外部事件（人工在 Gitea 侧的操作），生产 fake 无此入口
    this._testHook = {
      setPullExternal: (number, patch) => {
        const pr = this.st.pulls.get(Number(number));
        if (!pr) throw Errors.notFound('fake PR 不存在');
        Object.assign(pr, patch);
        return pr;
      },
    };
  }
  _repoId() {
    const u = String(this.binding.remote_url);
    return this.localGit ? `local:${bareDirOf(u)}` : `fake:${fakeSha(u).slice(0, 12)}`;
  }

  async getRepo() {
    const def = this.binding.default_branch || 'main';
    let head = this.st.branches.get(def);
    if (this.localGit) {
      const out = gitLsRemote(bareDirOf(this.binding.remote_url), ['HEAD']);
      head = out.split(/\s+/)[0] || head;
    }
    return {
      provider: this.binding.provider, repo: this._repoId(), defaultBranch: def,
      headCommit: head, url: this.binding.remote_url, simulated: true,
    };
  }
  async getBranchCommit(branch) {
    sanitizeBranchName(branch);
    if (this.localGit) {
      // pattern 精确匹配分支（分支名白名单无 glob 字符）
      const out = gitLsRemote(bareDirOf(this.binding.remote_url), ['--heads', branch]);
      const sha = out.split(/\s+/)[0];
      if (!sha) throw Errors.notFound(`分支不存在: ${branch}`);
      return { branch, sha, simulated: true };
    }
    const sha = this.st.branches.get(branch);
    if (!sha) throw Errors.notFound(`分支不存在: ${branch}`);
    return { branch, sha, simulated: true };
  }
  async listBranches() {
    if (this.localGit) {
      const out = git(bareDirOf(this.binding.remote_url),
        ['for-each-ref', '--format=%(objectname)%09%(refname:short)', 'refs/heads']);
      return out.split('\n').filter(Boolean).map((l) => {
        const [sha, name] = l.split('\t');
        return { name, sha, simulated: true };
      }).filter((b) => b.name && b.sha);
    }
    return [...this.st.branches.entries()].map(([name, sha]) => ({ name, sha, simulated: true }));
  }
  async listCommits(branch, limit = 20) {
    sanitizeBranchName(branch);
    if (this.localGit) {
      const dir = bareDirOf(this.binding.remote_url);
      const out = git(dir, ['log', `--format=%H%x01%s%x01%an%x01%aI`, '-n', String(Math.min(limit, 20)), branch]);
      return out.split('\n').filter(Boolean).map((l) => {
        const [sha, message, author, date] = l.split('\x01');
        return { sha, message: (message || '').slice(0, 200), author: author || '', date: date || '', simulated: true };
      });
    }
    const { sha } = await this.getBranchCommit(branch);
    return [{ sha, message: `fake commit on ${branch}`, author: 'fake', date: new Date().toISOString(), simulated: true }];
  }
  async createBranch({ branch, from }) {
    sanitizeBranchName(branch);
    if (!SHA_RE.test(String(from || ''))) throw Errors.badRequest('from 必须为 40 位 commit sha');
    if (this.localGit) {
      const dir = bareDirOf(this.binding.remote_url);
      git(dir, ['cat-file', '-t', from]); // 提交必须存在
      const ref = `refs/heads/${branch}`;
      let cur = '';
      try { cur = git(dir, ['rev-parse', '--verify', ref]); } catch { /* 不存在则创建 */ }
      if (cur && cur.toLowerCase() !== String(from).toLowerCase()) {
        throw Errors.conflict(`分支已存在且指向不同提交: ${branch}`);
      }
      if (!cur) git(dir, ['update-ref', ref, from]);
      return { branch, sha: from, existed: !!cur, simulated: true };
    }
    const cur = this.st.branches.get(branch);
    if (cur && cur.toLowerCase() !== String(from).toLowerCase()) {
      throw Errors.conflict(`分支已存在且指向不同提交: ${branch}`);
    }
    this.st.branches.set(branch, String(from).toLowerCase());
    return { branch, sha: String(from).toLowerCase(), existed: !!cur, simulated: true };
  }
  async createDraftPull({ head, base, title, body = '', draft }) {
    if (draft !== true) {
      throw Errors.badRequest('平台只允许创建草稿 PR（draft=true），禁止创建可直接评审合入的 PR',
        { code: 'DRAFT_REQUIRED' });
    }
    sanitizeBranchName(head);
    sanitizeBranchName(base);
    const t = String(title || '').trim();
    if (!t) throw Errors.badRequest('PR title 必填');
    const n = this.st.nextPr++;
    const pr = {
      number: n, title: t, head, base, draft: true, state: 'open', merged: false,
      url: `fake://${this._repoId()}/pulls/${n}`, body: String(body).slice(0, 8000),
    };
    this.st.pulls.set(n, pr);
    return { ...pr, repo: this._repoId(), status: 'draft', simulated: true };
  }
  async getPullStatus(number) {
    const pr = this.st.pulls.get(Number(number));
    if (!pr) throw Errors.notFound('fake PR 不存在');
    const status = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
    return { ...pr, status, simulated: true };
  }
  async listPulls() {
    return [...this.st.pulls.values()].filter((p) => p.state === 'open')
      .map((p) => ({ number: p.number, title: p.title, draft: p.draft, head: p.head, base: p.base, url: p.url, simulated: true }));
  }
  async listIssues() { return []; }
}

/**
 * 工厂：按 binding.provider + GITEA_URL 选择 live/fake。
 * gitlab provider：Gitea 客户端不处理（GitLab 适配器是独立扩展点）。
 */
export function createRepoClient({ binding, token }) {
  if (!binding) throw Errors.badRequest('repo binding 必填');
  if (binding.provider === 'gitlab') {
    throw Errors.badRequest('GitLab 仓库适配器尚未实现（扩展点），当前仅支持 gitea/local',
      { code: 'ADAPTER_NOT_IMPLEMENTED' });
  }
  if (binding.provider === 'gitea' && isGiteaLive()) {
    const live = new GiteaLiveClient({ binding, token });
    // 日志只记 owner/repo，绝不记完整 remote_url（防 URL 内嵌敏感信息）
    logger.info('repo client: gitea(live)', { repo: live._repoId() });
    return live;
  }
  logger.info('repo client: fake(fallback)', { provider: binding.provider });
  return new FakeRepoClient({ binding });
}

/** /readyz 上报 */
export function getRepoAdapterStatus() {
  return isGiteaLive() ? 'gitea(live)' : 'fake(fallback)';
}
