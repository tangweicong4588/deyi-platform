import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { apiKeysApi, isTenantAdmin, fmtTime } from '../../api/settings';
import type { ApiKey, IssuedKey, RotateResult } from '../../api/settings';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';
import './settings.css';

const SCOPE_LABEL: Record<string, string> = {
  'gateway.chat': '模型对话', 'gateway.embeddings': '向量嵌入',
  'knowledge.read': '知识库读', 'knowledge.write': '知识库写',
  'memory.read': '记忆读', 'memory.write': '记忆写',
  'billing.read': '账单读', 'billing.write': '账单写',
  'evidence.read': '审计读', 'evidence.write': '审计写',
  'artifacts.read': '制品读', 'artifacts.write': '制品写',
  'sagas.read': '长流程读', 'sagas.write': '长流程写',
  'identity.keys': '密钥管理',
};
const ALL_SCOPES = Object.keys(SCOPE_LABEL);

/** secret 只展示一次的面板 */
function SecretOnce({ title, secret, sub, onDone }: {
  title: string; secret: string; sub?: string; onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(secret); setCopied(true); }
    catch { /* 剪贴板不可用时用户手动复制 */ }
  };
  return (
    <Card title={title}>
      <Alert tone="warning">密钥只显示这一次！请立即复制保存，关闭后无法再次查看。</Alert>
      {sub && <p className="muted">{sub}</p>}
      <div className="secret-box">
        <code>{secret}</code>
      </div>
      <div className="row">
        <Button onClick={copy}>{copied ? '已复制' : '复制密钥'}</Button>
        <Button variant="ghost" onClick={onDone}>我已保存，关闭</Button>
      </div>
    </Card>
  );
}

export function ApiKeysPage() {
  const { token, me } = useAuth();
  const tenantId = me?.tenant?.id ?? null;
  const admin = isTenantAdmin(me);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 签发表单
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [actorId, setActorId] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState(''); // datetime-local
  const [allowlist, setAllowlist] = useState('');
  const [note, setNote] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  // 轮换
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [graceHours, setGraceHours] = useState('24');
  const [rotated, setRotated] = useState<RotateResult | null>(null);

  // 编辑白名单/备注
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editAllowlist, setEditAllowlist] = useState('');
  const [editNote, setEditNote] = useState('');

  const load = useCallback(async () => {
    if (!token || !tenantId || !admin) return;
    setLoading(true);
    setError(null);
    try {
      setKeys(await apiKeysApi.list(token, tenantId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, tenantId, admin]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (me?.actor?.id) setActorId((v) => v || me.actor.id); }, [me]);

  if (!admin) {
    return (
      <div>
        <div className="page-head"><h2>API 密钥</h2></div>
        <Alert tone="warning">需要租户管理员角色才能管理 API 密钥。</Alert>
      </div>
    );
  }

  const toggleScope = (s: string) =>
    setScopes((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));

  const parseAllowlist = (text: string) =>
    text.split('\n').map((l) => l.trim()).filter(Boolean);

  const onIssue = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !tenantId || !name.trim() || !actorId.trim()) return;
    setIssuing(true);
    setError(null);
    try {
      const r = await apiKeysApi.issue(token, tenantId, {
        actorId: actorId.trim(),
        name: name.trim(),
        scopes,
        expiresAt: expires ? new Date(expires).getTime() : null,
        ipAllowlist: parseAllowlist(allowlist),
        note: note.trim() || null,
      });
      setIssued(r);
      setName(''); setScopes([]); setExpires(''); setAllowlist(''); setNote('');
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '签发失败');
    } finally {
      setIssuing(false);
    }
  };

  const onRotate = async () => {
    if (!token || !tenantId || !rotating) return;
    const gh = Math.min(720, Math.max(1, Number(graceHours) || 24));
    setError(null);
    try {
      const r = await apiKeysApi.rotate(token, tenantId, rotating.id, gh);
      setRotated(r);
      setRotating(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '轮换失败');
    }
  };

  const onSaveEdit = async () => {
    if (!token || !tenantId || !editing) return;
    setError(null);
    try {
      await apiKeysApi.update(token, tenantId, editing.id, {
        ipAllowlist: parseAllowlist(editAllowlist),
        note: editNote.trim() || null,
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    }
  };

  const onRevoke = async (k: ApiKey) => {
    if (!token || !tenantId) return;
    if (!window.confirm(`确定吊销密钥「${k.name}」（${k.prefix}…）吗？吊销后立即失效，不可恢复。`)) return;
    setError(null);
    try {
      await apiKeysApi.revoke(token, tenantId, k.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '吊销失败');
    }
  };

  const secretOf = (k: IssuedKey) => k.secret ?? k.key ?? '';

  return (
    <div>
      <div className="page-head">
        <h2>API 密钥</h2>
        <Button onClick={() => setShowForm((v) => !v)}>签发新密钥</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      {issued && secretOf(issued) && (
        <SecretOnce
          title={`密钥已签发：${issued.name}`}
          secret={secretOf(issued)}
          sub="请把它配到调用方的 Authorization: Bearer 头里。"
          onDone={() => setIssued(null)}
        />
      )}
      {rotated && (
        <SecretOnce
          title="轮换完成"
          secret={rotated.newKey.secret ?? rotated.newKey.key ?? ''}
          sub={`旧密钥将在 ${fmtTime(rotated.graceUntil)} 后失效（宽限期内双密钥可用），请尽快把调用方切到新密钥。`}
          onDone={() => setRotated(null)}
        />
      )}

      {showForm && (
        <Card title="签发新密钥">
          <form onSubmit={onIssue} className="form-card">
            <TextField label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：数据同步服务" />
            <TextField label="绑定主体 actorId（默认当前登录用户）" value={actorId} onChange={(e) => setActorId(e.target.value)} />
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>权限范围（不选 = 不限制，向后兼容）</div>
              <div className="scope-grid">
                {ALL_SCOPES.map((s) => (
                  <label key={s} className="scope-check">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
                    <span>{SCOPE_LABEL[s]}<code className="muted"> {s}</code></span>
                  </label>
                ))}
              </div>
            </div>
            <TextField label="过期时间（不填 = 永不过期）" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <label className="muted">IP 白名单（每行一条，支持 1.2.3.4 或 1.2.3.0/24；不填 = 不限制）
              <textarea value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder={'203.0.113.10\n198.51.100.0/24'} />
            </label>
            <TextField label="备注" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row">
              <Button type="submit" loading={issuing}>签发</Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
            </div>
          </form>
        </Card>
      )}

      {rotating && (
        <Card title={`轮换密钥：${rotating.name}`}>
          <p className="muted">
            将签发一把继承相同权限的新密钥，旧密钥在宽限期后失效（宽限期内双密钥可用，平滑切换）。
          </p>
          <TextField label="宽限期（小时，1–720）" type="number" value={graceHours}
            onChange={(e) => setGraceHours(e.target.value)} />
          <div className="row">
            <Button onClick={onRotate}>确认轮换</Button>
            <Button variant="ghost" onClick={() => setRotating(null)}>取消</Button>
          </div>
        </Card>
      )}

      {editing && (
        <Card title={`编辑：${editing.name}`}>
          <div className="form-card">
            <label className="muted">IP 白名单（每行一条）
              <textarea value={editAllowlist} onChange={(e) => setEditAllowlist(e.target.value)} />
            </label>
            <TextField label="备注" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
            <div className="row">
              <Button onClick={onSaveEdit}>保存</Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            </div>
          </div>
        </Card>
      )}

      {loading ? <Spinner /> : (
        <div className="page-grid">
          {keys.length === 0 && <p className="muted">还没有 API 密钥</p>}
          {keys.map((k) => (
            <Card key={k.id}>
              <div className="list-item">
                <div>
                  <div className="list-item__title">{k.name} <code className="muted">{k.prefix}…</code></div>
                  <div className="list-item__meta">
                    状态 {k.status} · 过期 {fmtTime(k.expires_at)} · 最后使用 {fmtTime(k.last_used_at)}
                  </div>
                  <div className="list-item__meta">
                    权限 {(k.scopes ?? []).length === 0 ? '不限制' : (k.scopes ?? []).map((s) => SCOPE_LABEL[s] ?? s).join('、')}
                  </div>
                  {(k.ip_allowlist?.length ?? 0) > 0 && (
                    <div className="list-item__meta">IP 白名单：{k.ip_allowlist.join(', ')}</div>
                  )}
                  {k.note && <div className="list-item__meta">备注：{k.note}</div>}
                </div>
                <div className="row">
                  <span className="status-pill">{k.status}</span>
                  <button type="button" className="link-btn" onClick={() => setRotating(k)}>轮换</button>
                  <button type="button" className="link-btn" onClick={() => {
                    setEditing(k);
                    setEditAllowlist((k.ip_allowlist ?? []).join('\n'));
                    setEditNote(k.note ?? '');
                  }}>白名单/备注</button>
                  <button type="button" className="link-btn danger" onClick={() => onRevoke(k)}>吊销</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
