import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { doraApi } from '../../api/deliver';
import type { DoraReport, TraceResult } from '../../api/deliver';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import './deliver.css';
import { NoProjectHint } from '../../components/NoProjectHint';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';

const SEED_KINDS = ['requirement', 'change_package', 'pipeline_run', 'artifact_package', 'release'];

function fmtHours(h: number | null): string {
  if (h === null || h === undefined) return '—';
  return h >= 24 ? `${(h / 24).toFixed(1)} 天` : `${h.toFixed(1)} 小时`;
}

export function DoraPage() {
  const { token, projectId, projectsLoaded } = useAuth();
  const [report, setReport] = useState<DoraReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seedKind, setSeedKind] = useState('change_package');
  const [seedId, setSeedId] = useState('');
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true); setError(null);
    try {
      setReport(await doraApi.getReport(token, projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);
  if (projectsLoaded && !projectId) return <NoProjectHint pageName="效能看板" />;

  const onTrace = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !seedId.trim()) return;
    setTracing(true); setError(null);
    try {
      setTrace(await doraApi.trace(token, projectId, seedKind, seedId.trim()));
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : '追溯失败');
    } finally { setTracing(false); }
  };

  const r = report;
  return (
    <div className="page">
      <div className="page__head">
        <h2>效能看板</h2>
        <Button variant="ghost" onClick={() => load()}>刷新</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading ? <Spinner /> : r ? (
        <>
          <p className="muted">口径 {r.methodology} · 窗口 {new Date(r.window.from).toLocaleDateString()} – {new Date(r.window.to).toLocaleDateString()}</p>
          <div className="grid4">
            <Card title="部署频率">
              <div className="metric">{r.deployment_frequency.per_day.toFixed(2)}<span className="metric__unit"> 次/天</span></div>
              <p className="muted">{r.deployment_frequency.count} 次部署 / {r.deployment_frequency.window_days.toFixed(1)} 天</p>
            </Card>
            <Card title="变更前置时间">
              <div className="metric">{fmtHours(r.lead_time.median_hours)}</div>
              <p className="muted">中位数 · p90 {fmtHours(r.lead_time.p90_hours)} · {r.lead_time.count} 样本
                {r.lead_time.excluded_no_change_package > 0 && `（${r.lead_time.excluded_no_change_package} 个未关联变更包的发布未计入）`}</p>
            </Card>
            <Card title="变更失败率">
              <div className="metric">{(r.change_failure_rate.rate * 100).toFixed(1)}<span className="metric__unit"> %</span></div>
              <p className="muted">{r.change_failure_rate.failed} 失败 / {r.change_failure_rate.total} 部署</p>
            </Card>
            <Card title="恢复时间">
              <div className="metric">{fmtHours(r.time_to_restore.median_hours)}</div>
              <p className="muted">中位数 · {r.time_to_restore.count} 样本
                {r.time_to_restore.unrecovered > 0 && ` · ${r.time_to_restore.unrecovered} 个尚未恢复`}</p>
            </Card>
          </div>
        </>
      ) : <p className="muted">暂无数据</p>}
      <Card title="全链路追溯">
        <form onSubmit={onTrace} className="form__inline">
          <select value={seedKind} onChange={(e) => setSeedKind(e.target.value)}>
            {SEED_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <TextField label="" value={seedId} onChange={(e) => setSeedId(e.target.value)} placeholder="实体 ID" required />
          <Button type="submit" disabled={tracing || !seedId.trim()}>{tracing ? '追溯中…' : '追溯'}</Button>
        </form>
        {trace && (
          trace.chains.length === 0
            ? <p className="muted">无关联链路</p>
            : trace.chains.map((chain, ci) => (
              <div key={ci} className="chain">
                {chain.requirement && <p><strong>需求：</strong>{chain.requirement.title}</p>}
                {chain.change_package && <p><strong>变更包：</strong>{chain.change_package.title}</p>}
                {chain.timeline.length === 0
                  ? <p className="muted">无关联事件</p>
                  : <ol className="timeline">
                    {chain.timeline.map((t, i) => (
                      <li key={i} className="timeline__item">
                        <span className="muted">{new Date(t.ts).toLocaleString()}</span>
                        <strong> {t.kind}</strong>
                        <span> {t.label}</span>
                      </li>
                    ))}
                  </ol>}
              </div>
            ))
        )}
      </Card>
    </div>
  );
}
