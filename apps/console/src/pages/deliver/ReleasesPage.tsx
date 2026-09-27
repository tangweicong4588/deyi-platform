import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { releasesApi } from '../../api/deliver';
import type { DeployEnvironment, Release, ReleaseDetail } from '../../api/deliver';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import './deliver.css';
import { NoProjectHint } from '../../components/NoProjectHint';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', pending_approval: '待审批', approved: '已批准', rejected: '已驳回',
  deploying: '部署中', succeeded: '成功', failed: '失败', rolled_back: '已回滚',
};
const STRATEGIES = ['canary', 'bluegreen', 'rolling'];

export function ReleasesPage() {
  const { token, projectId, projectsLoaded } = useAuth();
  const [envs, setEnvs] = useState<DeployEnvironment[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [envKey, setEnvKey] = useState('staging');
  const [version, setVersion] = useState('');
  const [strategy, setStrategy] = useState('canary');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true); setError(null);
    try {
      const [e, r] = await Promise.all([
        releasesApi.listEnvironments(token, projectId).catch(() => []),
        releasesApi.listReleases(token, projectId),
      ]);
      setEnvs(e ?? []); setReleases(r ?? []);
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : '加载失败');
    } finally { setLoading(false); }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);
  if (projectsLoaded && !projectId) return <NoProjectHint pageName="发布管理" />;

  const refreshDetail = async (id: string) => {
    if (!token || !projectId) return;
    try { setDetail(await releasesApi.getRelease(token, projectId, id)); }
    catch (e) { setError(e instanceof ApiError ? e.message : '加载详情失败'); }
  };

  const act = async (fn: () => Promise<unknown>, id: string) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); await refreshDetail(id); }
    catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !version.trim()) return;
    setBusy(true);
    try {
      await releasesApi.createRelease(token, projectId, {
        environment_key: envKey, version: version.trim(), strategy,
        strategy_config: strategy === 'canary' ? { steps: [10, 50, 100] } : strategy === 'rolling' ? { batches: 2 } : {},
      });
      setVersion(''); setShowForm(false); await load();
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : '创建失败');
    } finally { setBusy(false); }
  };

  const d = detail?.release;
  return (
    <div className="page">
      <div className="page__head">
        <h2>发布管理</h2>
        <Button onClick={() => setShowForm((v) => !v)}>{showForm ? '取消' : '新建发布单'}</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="环境">
        {envs.length === 0
          ? <Button size="sm" onClick={() => token && projectId && act(() => releasesApi.ensureEnvironments(token, projectId), '')}>初始化默认环境</Button>
          : <div className="chips">{envs.map((e) => (
            <span key={e.id} className="chip">{e.name}（{e.key}）{e.requires_approval ? ' · 需审批' : ''}</span>
          ))}</div>}
      </Card>
      {showForm && (
        <Card title="新建发布单">
          <form onSubmit={onCreate}>
            <div className="form__row">
              <label className="form__label">环境</label>
              <select value={envKey} onChange={(e) => setEnvKey(e.target.value)}>
                {envs.map((e) => <option key={e.id} value={e.key}>{e.name}</option>)}
              </select>
            </div>
            <TextField label="版本" value={version} onChange={(e) => setVersion(e.target.value)} required placeholder="v1.2.0" />
            <div className="form__row">
              <label className="form__label">策略</label>
              <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <Button type="submit" disabled={busy || !version.trim()}>{busy ? '创建中…' : '创建'}</Button>
          </form>
        </Card>
      )}
      {loading ? <Spinner /> : (
        <Card title="发布单">
          {releases.length === 0 ? <p className="muted">暂无发布单</p> : (
            <ul className="list">
              {releases.map((r) => (
                <li key={r.id} className="list__item" onClick={() => refreshDetail(r.id)} style={{ cursor: 'pointer' }}>
                  <div><strong>{r.version}</strong> <span className="muted">· {r.strategy}</span></div>
                  <span className={`badge badge--${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {d && token && projectId && (
        <Card title={`发布单 ${d.version}`}>
          <p className="muted">状态：{STATUS_LABEL[d.status] ?? d.status}{d.requires_approval ? ' · 需审批' : ''}</p>
          {detail.steps.length > 0 && (
            <ul className="list">
              {detail.steps.map((s) => (
                <li key={s.seq} className="list__item">
                  <span>{s.seq}. {s.label}</span>
                  <span className={`badge badge--${s.status}`}>{s.status}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="form__actions">
            {d.status === 'draft' && d.requires_approval && (
              <Button size="sm" disabled={busy} onClick={() => act(() => releasesApi.requestApproval(token, projectId, d.id), d.id)}>发起审批</Button>
            )}
            {d.status === 'pending_approval' && (
              <>
                <Button size="sm" disabled={busy} onClick={() => act(() => releasesApi.approve(token, projectId, d.id), d.id)}>批准</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => releasesApi.reject(token, projectId, d.id, '控制台驳回'), d.id)}>驳回</Button>
              </>
            )}
            {(d.status === 'approved' || d.status === 'draft') && (
              <Button size="sm" disabled={busy} onClick={() => act(() => releasesApi.start(token, projectId, d.id, 'simulated'), d.id)}>启动（演练）</Button>
            )}
            {d.status === 'failed' && (
              <Button size="sm" disabled={busy} onClick={() => act(() => releasesApi.rollback(token, projectId, d.id), d.id)}>回滚</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>收起</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
