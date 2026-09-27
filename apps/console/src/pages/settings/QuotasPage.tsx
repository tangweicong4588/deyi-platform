import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { quotasApi, isTenantAdmin, fmtMoney, fmtTime, fmtNum } from '../../api/settings';
import type { Budget, UsageCall } from '../../api/settings';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';
import './settings.css';

function UsageBar({ used, limit, format }: {
  used: number; limit: number | null; format: (n: number) => string;
}) {
  if (limit == null) return <span className="muted">{format(used)} / 不限制</span>;
  const pct = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div>
      <div className="muted">{format(used)} / {format(limit)}（{pct}%）</div>
      <div className="quota-bar"><i style={{ width: `${pct}%` }} className={used > limit ? 'over' : ''} /></div>
    </div>
  );
}

export function QuotasPage() {
  const { token, me } = useAuth();
  const tenantId = me?.tenant?.id ?? null;
  const admin = isTenantAdmin(me);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [calls, setCalls] = useState<UsageCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 手工预算表单
  const [costYuan, setCostYuan] = useState('');
  const [tokenLimit, setTokenLimit] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token || !tenantId || !admin) return;
    setLoading(true);
    setError(null);
    try {
      const [b, u] = await Promise.all([
        quotasApi.budgets(token, tenantId),
        quotasApi.usage(token, tenantId, 50),
      ]);
      setBudgets(b);
      setCalls(u);
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
        <div className="page-head"><h2>配额用量</h2></div>
        <Alert tone="warning">需要租户管理员角色才能查看配额用量。</Alert>
      </div>
    );
  }

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !tenantId) return;
    const costLimitCents = costYuan.trim() === '' ? null : Math.round(Number(costYuan) * 100);
    const tLimit = tokenLimit.trim() === '' ? null : Number(tokenLimit);
    if (costLimitCents == null && tLimit == null) {
      setError('请至少填写一项限额');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await quotasApi.setBudget(token, tenantId, {
        projectId: null, period: 'monthly', costLimitCents, tokenLimit: tLimit,
      });
      setCostYuan(''); setTokenLimit('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h2>配额用量</h2>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      {loading ? <Spinner /> : (
        <>
          <div className="page-grid">
            {budgets.length === 0 && <p className="muted">还没有预算（开通租户或同步套餐后自动生成）</p>}
            {budgets.map((b) => (
              <Card key={b.id} title={`${b.period === 'monthly' ? '月度' : b.period}预算 · ${b.source === 'plan' ? '套餐' : '手工'}`}>
                <div className="list-item__meta" style={{ marginBottom: 8 }}>
                  范围：{b.project_id ? `项目 ${b.project_id}` : '租户级'}
                </div>
                <div className="muted" style={{ marginBottom: 4 }}>Token 用量</div>
                <UsageBar used={b.used_tokens} limit={b.token_limit} format={fmtNum} />
                <div className="muted" style={{ margin: '10px 0 4px' }}>费用用量</div>
                <UsageBar used={b.used_cost_cents} limit={b.cost_limit_cents} format={fmtMoney} />
              </Card>
            ))}
          </div>

          <Card title="设置手工预算（租户级，月度）">
            <form onSubmit={onSave} className="row">
              <TextField label="费用上限（元，不填=不限制）" type="number" value={costYuan}
                onChange={(e) => setCostYuan(e.target.value)} placeholder="如 500" />
              <TextField label="Token 上限（不填=不限制）" type="number" value={tokenLimit}
                onChange={(e) => setTokenLimit(e.target.value)} placeholder="如 10000000" />
              <Button type="submit" loading={saving}>保存</Button>
            </form>
            <p className="muted">手工预算优先于套餐预算；超限后网关返回 402 并触发告警。</p>
          </Card>

          <Card title="最近模型调用（不含 prompt 原文）">
            {calls.length === 0 ? <p className="muted">暂无调用记录</p> : (
              <table className="data-table">
                <thead><tr><th>时间</th><th>模型</th><th>Tokens</th><th>费用</th><th>状态</th></tr></thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id}>
                      <td>{fmtTime(c.created_at)}</td>
                      <td>{c.model}</td>
                      <td>{fmtNum(c.tokens)}</td>
                      <td>{fmtMoney(c.cost_cents)}</td>
                      <td>{c.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
