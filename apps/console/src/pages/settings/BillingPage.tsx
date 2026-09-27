import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { billingApi, isTenantAdmin, fmtMoney, fmtTime, fmtNum, currentPeriodKey } from '../../api/settings';
import type { Invoice } from '../../api/settings';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';
import './settings.css';

const STATUS_LABEL: Record<Invoice['status'], string> = {
  draft: '草稿', finalized: '已定稿', paid: '已支付', void: '已作废',
};

export function BillingPage() {
  const { token, me } = useAuth();
  const tenantId = me?.tenant?.id ?? null;
  const admin = isTenantAdmin(me);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [period, setPeriod] = useState(currentPeriodKey());
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!token || !tenantId || !admin) return;
    setLoading(true);
    setError(null);
    try {
      setInvoices((await billingApi.list(token, tenantId)) ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, tenantId, admin]);

  useEffect(() => { void load(); }, [load]);

  if (!admin) {
    return (
      <div>
        <div className="page-head"><h2>账单</h2></div>
        <Alert tone="warning">需要租户管理员角色才能查看账单。</Alert>
      </div>
    );
  }

  const onGenerate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !tenantId || !period.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const inv = await billingApi.generate(token, tenantId, period.trim());
      setDetail(inv);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const act = (fn: (t: string, tid: string, id: string) => Promise<Invoice>, label: string) => async () => {
    if (!token || !tenantId || !detail) return;
    if (!window.confirm(`确定对账单 ${detail.period_key} 执行「${label}」吗？`)) return;
    setActing(true);
    setError(null);
    try {
      const inv = await fn(token, tenantId, detail.id);
      setDetail(inv);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setActing(false);
    }
  };

  const actions: Array<{ label: string; fn: (t: string, tid: string, id: string) => Promise<Invoice> }> = [];
  if (detail?.status === 'draft') {
    actions.push({ label: '定稿', fn: billingApi.finalize }, { label: '作废', fn: billingApi.void });
  } else if (detail?.status === 'finalized') {
    actions.push({ label: '标记已付', fn: billingApi.pay }, { label: '作废', fn: billingApi.void });
  }

  return (
    <div>
      <div className="page-head">
        <h2>账单</h2>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      <Card title="生成账单（草稿）">
        <form onSubmit={onGenerate} className="row">
          <TextField label="账期（YYYY-MM）" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <Button type="submit" loading={generating}>生成 / 重算草稿</Button>
        </form>
        <p className="muted">草稿 = 当月套餐月费 + 模型调用计量快照；定稿后冻结，不可重算。</p>
      </Card>

      {detail && (
        <Card title={`账单 ${detail.period_key}`}>
          <dl className="kv">
            <dt>状态</dt><dd><span className="status-pill">{STATUS_LABEL[detail.status]}</span></dd>
            <dt>套餐</dt><dd>{detail.plan}（{fmtMoney(detail.plan_fee_cents)}）</dd>
            <dt>用量</dt><dd>{fmtNum(detail.usage_calls)} 次调用 · {fmtNum(detail.usage_tokens)} tokens · {fmtMoney(detail.usage_cost_cents)}</dd>
            <dt>合计</dt><dd><strong>{fmtMoney(detail.total_cents)}</strong> {detail.currency}</dd>
            <dt>创建时间</dt><dd>{fmtTime(detail.created_at)}</dd>
            {detail.finalized_at && <><dt>定稿时间</dt><dd>{fmtTime(detail.finalized_at)}</dd></>}
            {detail.paid_at && <><dt>支付时间</dt><dd>{fmtTime(detail.paid_at)}</dd></>}
            {detail.voided_at && <><dt>作废时间</dt><dd>{fmtTime(detail.voided_at)}</dd></>}
          </dl>
          {detail.line_items.length > 0 && (
            <table className="data-table">
              <thead><tr><th>行项目</th><th>金额</th></tr></thead>
              <tbody>
                {detail.line_items.map((li, i) => (
                  <tr key={i}>
                    <td>{li.label}{li.needs_pricing ? '（待运营定价）' : ''}</td>
                    <td>{fmtMoney(li.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {actions.length > 0 && (
            <div className="row" style={{ marginTop: 12 }}>
              {actions.map((a) => (
                <Button key={a.label} onClick={act(a.fn, a.label)} loading={acting}>{a.label}</Button>
              ))}
              <Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>
            </div>
          )}
          {actions.length === 0 && (
            <div className="row" style={{ marginTop: 12 }}>
              <Button variant="ghost" onClick={() => setDetail(null)}>关闭</Button>
            </div>
          )}
        </Card>
      )}

      {loading ? <Spinner /> : (
        <div className="page-grid">
          {invoices.length === 0 && <p className="muted">还没有账单</p>}
          {invoices.map((inv) => (
            <Card key={inv.id}>
              <div className="list-item">
                <div>
                  <div className="list-item__title">{inv.period_key} <span className="muted">{inv.plan}</span></div>
                  <div className="list-item__meta">
                    合计 {fmtMoney(inv.total_cents)} · {fmtNum(inv.usage_calls)} 次调用 · {fmtNum(inv.usage_tokens)} tokens
                  </div>
                </div>
                <div className="row">
                  <span className="status-pill">{STATUS_LABEL[inv.status]}</span>
                  <button type="button" className="link-btn" onClick={() => setDetail(inv)}>详情</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
