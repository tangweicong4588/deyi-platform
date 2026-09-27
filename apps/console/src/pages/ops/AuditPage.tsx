import { useState } from 'react';
import { useOpsAuth } from '../../auth/OpsAuthContext';
import { opsApi } from '../../api/ops';
import type { AuditManifest } from '../../api/ops';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { Alert } from '../../components/ui/Alert';
import { Card } from '../../components/ui/Card';

/**
 * 审计与合规：合规导出（下载 + manifest 展示）、单租户锚定状态/验证、全租户锚定跑批。
 */
export function AuditPage() {
  const { token } = useOpsAuth();
  const [tenantId, setTenantId] = useState('');
  const [format, setFormat] = useState<'jsonl' | 'csv'>('jsonl');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manifest, setManifest] = useState<AuditManifest | null>(null);
  const [anchor, setAnchor] = useState<Record<string, unknown> | null>(null);
  const [verify, setVerify] = useState<Record<string, unknown> | null>(null);
  const [anchorAllRes, setAnchorAllRes] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (!token || !tenantId.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await opsApi.exportCompliance(token, tenantId.trim(), { format });
      const m = opsApi.parseManifest(res);
      setManifest(m);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const cd = res.headers.get('content-disposition') ?? '';
      const fn = cd.match(/filename="([^"]+)"/)?.[1] ?? `audit-${tenantId.trim()}.${format}`;
      a.href = url;
      a.download = fn;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setNotice(`合规包已下载：${fn}（${blob.size} 字节）`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const loadAnchor = async () => {
    if (!token || !tenantId.trim()) return;
    setError(null);
    try {
      setAnchor(await opsApi.anchorStatus(token, tenantId.trim()));
      setVerify(await opsApi.verifyAnchors(token, tenantId.trim()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '锚定查询失败');
    }
  };

  const runAnchorAll = async () => {
    if (!token) return;
    if (!window.confirm('对所有租户执行锚定跑批？')) return;
    setBusy(true);
    setError(null);
    try {
      setAnchorAllRes(await opsApi.anchorAll(token));
      setNotice('全租户锚定跑批完成');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '锚定跑批失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h2>审计与合规</h2>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title="合规导出">
        <p className="muted">
          导出租户审计事件（JSONL/CSV，上限 1 万条），响应头 <span className="mono">x-audit-manifest</span>{' '}
          携带 manifest（含内容 sha256、导出时刻链验证结论、锚定状态）。
        </p>
        <div className="form__inline">
          <TextField label="租户 id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="ten_…" />
          <label className="form__label">
            格式
            <select value={format} onChange={(e) => setFormat(e.target.value as 'jsonl' | 'csv')}>
              <option value="jsonl">jsonl</option>
              <option value="csv">csv</option>
            </select>
          </label>
          <Button onClick={download} disabled={busy || !tenantId.trim()}>
            {busy ? '导出中…' : '导出并下载'}
          </Button>
          <Button variant="ghost" onClick={loadAnchor} disabled={!tenantId.trim()}>
            查询锚定状态
          </Button>
        </div>
        {manifest && (
          <table className="ops-table">
            <tbody>
              <tr><td>文件名</td><td className="mono">{manifest.filename}</td></tr>
              <tr><td>事件数</td><td>{manifest.event_count}{manifest.truncated ? '（已截断至上限）' : ''}</td></tr>
              <tr><td>内容 sha256</td><td className="mono">{manifest.content_sha256}</td></tr>
              <tr><td>链验证结论</td><td className="mono">{JSON.stringify(manifest.chain_verification)}</td></tr>
              <tr><td>最新锚定</td><td className="mono">{JSON.stringify(manifest.latest_anchor)}</td></tr>
            </tbody>
          </table>
        )}
      </Card>

      {(anchor || verify) && (
        <Card title={`锚定状态 — ${tenantId}`}>
          <p>
            锚定状态：{' '}
            <span className={`badge ${anchor && (anchor as { anchored?: boolean }).anchored ? 'badge--approved' : 'badge--deploying'}`}>
              {anchor ? String((anchor as { anchored?: boolean }).anchored) : '—'}
            </span>
          </p>
          {verify && (
            <p className="muted">
              链验证：<span className="mono">{JSON.stringify(verify)}</span>
              （锚定后链被改写会检出 broken）
            </p>
          )}
        </Card>
      )}

      <Card title="全租户锚定跑批">
        <p className="muted">对所有租户执行锚定（未配置锚定端点时如实返回 anchored:false）。</p>
        <div className="form__actions">
          <Button onClick={runAnchorAll} disabled={busy}>
            {busy ? '执行中…' : '执行 anchor-all'}
          </Button>
        </div>
        {anchorAllRes && (
          <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(anchorAllRes, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}
