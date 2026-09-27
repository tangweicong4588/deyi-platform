import { useState } from 'react';
import { useOpsAuth } from '../../auth/OpsAuthContext';
import { opsApi } from '../../api/ops';
import type { OffboardDryRun, OffboardConfirm } from '../../api/ops';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { Alert } from '../../components/ui/Alert';
import { Card } from '../../components/ui/Card';

/**
 * 租户销户：两阶段——先 dryRun 看统计与合规包 manifest，再用 confirm_token 确认执行。
 * 销户不可逆：业务数据全删（账单头与外部锚定引用保留），页面要求输入租户 id 二次确认。
 */
export function OffboardPage() {
  const { token } = useOpsAuth();
  const [tenantId, setTenantId] = useState('');
  const [dryRun, setDryRun] = useState<OffboardDryRun | null>(null);
  const [result, setResult] = useState<OffboardConfirm | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doDryRun = async () => {
    if (!token || !tenantId.trim()) return;
    setBusy(true);
    setError(null);
    setDryRun(null);
    setResult(null);
    try {
      const r = await opsApi.offboardDryRun(token, tenantId.trim());
      setDryRun(r);
      setConfirmInput('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'dryRun 失败');
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!token || !dryRun) return;
    if (confirmInput.trim() !== dryRun.tenant_id) {
      setError('二次确认输入的租户 id 与目标不一致，已拦截');
      return;
    }
    if (!window.confirm(`最后确认：销户租户 ${dryRun.tenant_id}，业务数据将被删除且不可逆！`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await opsApi.offboardConfirm(token, dryRun.tenant_id, dryRun.confirm_token);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '销户执行失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h2>租户销户</h2>
      </div>
      <Alert tone="warning">
        销户为不可逆操作：租户业务数据按 FK 拓扑序删除，向量派生索引同步清除；账单头与外部锚定引用保留。
        必须先执行 dryRun，再用其签发的 confirm_token（15 分钟有效，绑定数据快照）确认。
      </Alert>
      {error && <Alert tone="danger">{error}</Alert>}

      <Card title="第一步：dryRun 预演">
        <div className="form__inline">
          <TextField label="租户 id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="ten_…" />
          <Button onClick={doDryRun} disabled={busy || !tenantId.trim()}>
            {busy ? '执行中…' : '执行 dryRun'}
          </Button>
        </div>
      </Card>

      {dryRun && (
        <Card title={`预演结果 — ${dryRun.tenant_id}（状态：${dryRun.tenant_status}）`}>
          <p>
            待删除总行数：<strong>{dryRun.total_rows_to_delete}</strong>
          </p>
          <table className="ops-table">
            <thead>
              <tr>
                <th>表</th>
                <th>行数</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dryRun.counts)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([table, n]) => (
                  <tr key={table}>
                    <td className="mono">{table}</td>
                    <td>{n}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="muted">
            保留：账单头 {dryRun.kept.billing_invoices} 条、锚定 {dryRun.kept.anchors} 条。
            {dryRun.kept.note}
          </p>
          <p className="muted">
            合规包 manifest：{dryRun.export_manifest.filename}，
            事件 {dryRun.export_manifest.event_count} 条，
            sha256 <span className="mono">{dryRun.export_manifest.content_sha256.slice(0, 16)}…</span>，
            链验证 <span className="mono">{JSON.stringify(dryRun.export_manifest.chain_verification)}</span>
          </p>
        </Card>
      )}

      {dryRun && !result && (
        <Card title="第二步：确认销户">
          <p className="muted">
            confirm_token 已签发（15 分钟有效，绑定 dryRun 时的数据快照；期间数据变化则确认被拒绝）。
            请在下方输入租户 id <span className="mono">{dryRun.tenant_id}</span> 以确认。
          </p>
          <div className="form__inline">
            <TextField label="输入租户 id 确认" value={confirmInput} onChange={(e) => setConfirmInput(e.target.value)} />
            <Button variant="danger" onClick={doConfirm} disabled={busy || !confirmInput.trim()}>
              {busy ? '执行中…' : '确认销户（不可逆）'}
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card title="销户执行结果">
          {result.already_purged ? (
            <Alert tone="info">该租户已处于 purged 状态（幂等返回），purged_at={result.purged_at}</Alert>
          ) : (
            <>
              <Alert tone="success">
                租户 {result.tenant_id} 已销户，purged_at={result.purged_at}。
                审计 wipe {result.audit?.wiped_events} 条事件，检查点 {result.audit?.checkpoint_id}。
              </Alert>
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>表</th>
                    <th>删除行数</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.deleted_tables ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([table, n]) => (
                      <tr key={table}>
                        <td className="mono">{table}</td>
                        <td>{n}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
