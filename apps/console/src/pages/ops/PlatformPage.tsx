import { useCallback, useEffect, useState } from 'react';
import { useOpsAuth } from '../../auth/OpsAuthContext';
import { opsApi } from '../../api/ops';
import type { Readiness, SweepResult } from '../../api/ops';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { Alert } from '../../components/ui/Alert';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';

/** 平台运维：系统健康（healthz/readyz）、数据保留清扫 */
export function PlatformPage() {
  const { token } = useOpsAuth();
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 保留清扫
  const [sweepTenant, setSweepTenant] = useState('');
  const [sweepDry, setSweepDry] = useState(true);
  const [sweepRes, setSweepRes] = useState<SweepResult | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, r] = await Promise.all([opsApi.healthz(), opsApi.readyz()]);
      setHealth(h);
      setReady(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '健康检查失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runSweep = async () => {
    if (!token) return;
    if (!sweepDry && !window.confirm('确认对真实数据执行保留清扫（非 dryRun）？')) return;
    setSweepBusy(true);
    setError(null);
    try {
      const r = await opsApi.retentionSweep(token, {
        tenantId: sweepTenant.trim() || undefined,
        dryRun: sweepDry,
      });
      setSweepRes(r);
      setNotice(`保留清扫完成（dry_run=${r.dry_run}，租户数=${r.tenants}）`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '清扫失败');
    } finally {
      setSweepBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h2>平台运维</h2>
        <Button variant="ghost" onClick={load} disabled={loading}>
          刷新
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title="系统健康">
        {loading ? (
          <Spinner />
        ) : (
          <>
            <p>
              liveness：<span className="badge badge--approved">alive</span>{' '}
              {health && <span className="mono muted">{JSON.stringify(health)}</span>}
            </p>
            <p>
              readiness：{' '}
              <span className={`badge ${ready?.status === 'ready' ? 'badge--approved' : 'badge--failed'}`}>
                {ready?.status ?? 'unknown'}
              </span>
            </p>
            {ready?.checks && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                checks: {JSON.stringify(ready.checks, null, 2)}
              </pre>
            )}
            {ready?.adapters && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                adapters: {JSON.stringify(ready.adapters, null, 2)}
              </pre>
            )}
            {ready?.error && <Alert tone="danger">{ready.error}</Alert>}
          </>
        )}
      </Card>

      <Card title="数据保留清扫">
        <p className="muted">
          按保留策略删除过期数据（审计默认 730 天、计量 180 天、投递 90 天、outbox 30 天；
          制品 365 天，可被租户/包级覆盖）。只删终态数据；审计只删连续前缀并追加检查点。
        </p>
        <div className="form__inline">
          <TextField label="租户 id（留空=全租户）" value={sweepTenant} onChange={(e) => setSweepTenant(e.target.value)} placeholder="ten_…" />
          <label className="check">
            <input type="checkbox" checked={sweepDry} onChange={(e) => setSweepDry(e.target.checked)} />
            dryRun（只统计不删除）
          </label>
          <Button onClick={runSweep} disabled={sweepBusy} variant={sweepDry ? 'primary' : 'danger'}>
            {sweepBusy ? '执行中…' : sweepDry ? '预演清扫' : '执行清扫'}
          </Button>
        </div>
        {sweepRes && (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(sweepRes, null, 2).slice(0, 4000)}
          </pre>
        )}
      </Card>
    </div>
  );
}
