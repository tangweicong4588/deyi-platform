import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { pipelinesApi } from '../../api/deliver';
import type { PipelineTemplate } from '../../api/deliver';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import './deliver.css';
import { NoProjectHint } from '../../components/NoProjectHint';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';

// 后端 V3.1 阶段口径：STAGE_ORDER = facts/requirements/clarify/develop/handover
const STAGES = ['facts', 'requirements', 'clarify', 'develop', 'handover'];
const STAGE_LABEL: Record<string, string> = {
  facts: '信息采集', requirements: '需求', clarify: '澄清', develop: '开发', handover: '交接',
};

export function PipelinesPage() {
  const { token, projectId, projectsLoaded } = useAuth();
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [runs, setRuns] = useState<Array<{ id: string; change_package_id: string; status: string }>>([]);
  const [packages, setPackages] = useState<Array<{ id: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [stages, setStages] = useState<string[]>(['facts', 'requirements', 'clarify', 'develop', 'handover']);
  const [instTarget, setInstTarget] = useState<{ templateId: string; pkg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true); setError(null);
    try {
      const [t, r, p] = await Promise.all([
        pipelinesApi.listTemplates(token, projectId),
        pipelinesApi.listRuns(token, projectId).catch(() => []),
        pipelinesApi.listChangePackages(token, projectId).catch(() => []),
      ]);
      setTemplates(t ?? []); setRuns(r ?? []); setPackages(p ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);
  if (projectsLoaded && !projectId) return <NoProjectHint pageName="交付流水线" />;

  const toggleStage = (s: string) =>
    setStages((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort((a, b) => STAGES.indexOf(a) - STAGES.indexOf(b)));

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !name.trim() || stages.length === 0) return;
    setBusy(true);
    try {
      // 创建时即带上阶段定义（后端 createTemplate 同时建初始版本 v1）
      const t = await pipelinesApi.createTemplate(token, projectId, {
        name: name.trim(),
        stages: stages.map((s) => ({ key: s, name: STAGE_LABEL[s] })),
      });
      setName(''); setShowForm(false); await load();
      void t;
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : '创建失败');
    } finally { setBusy(false); }
  };

  const onInstantiate = async () => {
    if (!token || !projectId || !instTarget?.pkg) return;
    setBusy(true);
    try {
      await pipelinesApi.instantiate(token, projectId, instTarget.templateId, { changePackageId: instTarget.pkg });
      setInstTarget(null); await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '实例化失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h2>交付流水线</h2>
        <Button onClick={() => setShowForm((v) => !v)}>{showForm ? '取消' : '新建模板'}</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {showForm && (
        <Card title="新建流水线模板">
          <form onSubmit={onCreate}>
            <TextField label="模板名称" value={name} onChange={(e) => setName(e.target.value)} required />
            <div className="form__row">
              <span className="form__label">阶段（至少选一个）</span>
              {STAGES.map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" checked={stages.includes(s)} onChange={() => toggleStage(s)} />
                  {STAGE_LABEL[s]}
                </label>
              ))}
            </div>
            <Button type="submit" disabled={busy || !name.trim() || stages.length === 0}>
              {busy ? '创建中…' : '创建并发布默认版本'}
            </Button>
          </form>
        </Card>
      )}
      {loading ? <Spinner /> : (
        <>
          <Card title="模板">
            {templates.length === 0 ? <p className="muted">暂无模板</p> : (
              <ul className="list">
                {templates.map((t) => (
                  <li key={t.id} className="list__item">
                    <div>
                      <strong>{t.name}</strong>
                      <span className="muted"> · {t.visibility === 'shared' ? '租户共享' : '项目私有'} · 当前版本 {t.current_version ?? '—'}</span>
                    </div>
                    <Button size="sm" onClick={() => setInstTarget({ templateId: t.id, pkg: packages[0]?.id ?? '' })}>
                      实例化
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="流水线运行">
            {runs.length === 0 ? <p className="muted">暂无运行记录</p> : (
              <ul className="list">
                {runs.map((r) => (
                  <li key={r.id} className="list__item">
                    <span className="mono">{r.id.slice(0, 12)}…</span>
                    <span className="muted">变更包 {r.change_package_id.slice(0, 8)}…</span>
                    <span className={`badge badge--${r.status}`}>{r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {instTarget && (
        <Card title="实例化模板">
          <div className="form__row">
            <label className="form__label">选择变更包</label>
            <select value={instTarget.pkg} onChange={(e) => setInstTarget({ ...instTarget, pkg: e.target.value })}>
              {packages.length === 0 && <option value="">暂无变更包</option>}
              {packages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </div>
          <div className="form__actions">
            <Button onClick={onInstantiate} disabled={busy || !instTarget.pkg}>{busy ? '实例化中…' : '确认实例化'}</Button>
            <Button variant="ghost" onClick={() => setInstTarget(null)}>取消</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
