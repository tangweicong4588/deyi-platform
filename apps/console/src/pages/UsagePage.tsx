import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { billingApi } from '../api/console';
import type { Invoice } from '../api/console';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { Alert } from '../components/ui/Alert';
import { Spinner } from '../components/ui/Spinner';

export function UsagePage() {
  const { token, me } = useAuth();
  const tenantId = me?.tenant?.id ?? null;
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token || !tenantId) return;
    setLoading(true);
    setError(null);
    try {
      setInvoices((await billingApi.invoices(token, tenantId)) ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError('账单查看需要租户管理员角色');
      } else {
        setError(e instanceof ApiError ? e.message : '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, [token, tenantId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="page-head"><h2>用量与账单</h2></div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="账单列表">
        {loading ? <Spinner /> : invoices.length === 0 && !error ? <p className="muted">暂无账单</p> : (
          <table className="data">
            <thead><tr><th>账期</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.period_key}</td>
                  <td>{(inv.total_cents / 100).toFixed(2)} {inv.currency}</td>
                  <td><span className="status-pill">{inv.status}</span></td>
                  <td>{new Date(inv.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
