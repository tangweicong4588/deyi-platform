import { useCallback, useEffect, useState } from 'react';
import { useOpsAuth } from '../../auth/OpsAuthContext';
import { opsApi } from '../../api/ops';
import type { Tenant, ProvisionResult } from '../../api/ops';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { Alert } from '../../components/ui/Alert';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';

/** 租户管理：列表 / 开通 / 原子开通（含管理员+API Key）/ 暂停 / 恢复 / 套餐配额 */
export function TenantsPage() {
  const { token } = useOpsAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 开通表单
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [plan, setPlan] = useState('trial');
  const [provisionMode, setProvisionMode] = useState(false);
  const [adminName, setAdminName] = useState('admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [provisioned, setProvisioned] = useState<ProvisionResult | null>(null);
  const [busy, setBusy] = useState(false);

  // 套餐/配额编辑
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [editPlan, setEditPlan] = useState('');
  const [editQuotas, setEditQuotas] = useState('');

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setTenants(await opsApi.listTenants(token));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!token || !name.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (provisionMode) {
        const r = await opsApi.provisionTenant(token, {
          name: name.trim(),
          slug: slug.trim() || undefined,
          plan,
          adminName: adminName.trim() || 'admin',
          adminEmail: adminEmail.trim() || undefined,
        });
        setProvisioned(r);
        setNotice(`租户 ${r.tenant.id} 原子开通完成（项目/管理员/API Key 已建）`);
      } else {
        const t = await opsApi.createTenant(token, { name: name.trim(), slug: slug.trim() || undefined, plan });
        setNotice(`租户 ${t.id} 已创建`);
      }
      setName('');
      setSlug('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (t: Tenant, action: 'suspend' | 'resume') => {
    if (!token) return;
    const verb = action === 'suspend' ? '停用' : '恢复';
    if (!window.confirm(`确认${verb}租户「${t.name}」（${t.id}）？${action === 'suspend' ? '停用后该租户所有 API Key/JWT 立即 401。' : ''}`)) return;
    try {
      await (action === 'suspend' ? opsApi.suspendTenant(token, t.id) : opsApi.resumeTenant(token, t.id));
      setNotice(`租户 ${t.id} 已${verb}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${verb}失败`);
    }
  };

  const savePlan = async () => {
    if (!token || !editing) return;
    let quotas: Record<string, number | null> | undefined;
    if (editQuotas.trim()) {
      try {
        quotas = JSON.parse(editQuotas);
      } catch {
        setError('配额必须是合法 JSON（如 {"max_api_keys": 50}，null 表示不限）');
        return;
      }
    }
    try {
      await opsApi.patchTenant(token, editing.id, { plan: editPlan || undefined, quotas });
      setNotice(`租户 ${editing.id} 套餐/配额已更新`);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '更新失败');
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <h2>租户管理</h2>
        <Button variant="ghost" onClick={load} disabled={loading}>
          刷新
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card title="开通租户">
        <div className="form__inline">
          <TextField label="租户名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="必填" />
          <TextField label="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="默认按名称生成" />
          <label className="form__label">
            套餐
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="trial">trial</option>
              <option value="professional">professional</option>
              <option value="enterprise">enterprise</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={provisionMode} onChange={(e) => setProvisionMode(e.target.checked)} />
            原子开通（同时建默认项目/管理员/API Key）
          </label>
        </div>
        {provisionMode && (
          <div className="form__inline">
            <TextField label="管理员名称" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            <TextField label="管理员邮箱" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="可选" />
          </div>
        )}
        <div className="form__actions">
          <Button onClick={create} disabled={busy || !name.trim()}>
            {busy ? '创建中…' : provisionMode ? '原子开通' : '创建租户'}
          </Button>
        </div>
        {provisioned && (
          <Alert tone="warning">
            开通成功：租户 <span className="mono">{provisioned.tenant.id}</span>，
            管理员 <span className="mono">{provisioned.actor.name}</span>，
            API Key <span className="mono">{provisioned.apiKey.prefix}…</span> 的 secret 只显示一次：
            <br />
            <span className="mono">{provisioned.apiKey.key}</span>
            <br />
            请立即复制保存，关闭后不再显示。
          </Alert>
        )}
      </Card>

      <Card title={`租户列表（${tenants.length}）`}>
        {loading ? (
          <Spinner />
        ) : tenants.length === 0 ? (
          <p className="muted">暂无租户</p>
        ) : (
          <ul className="list">
            {tenants.map((t) => (
              <li key={t.id} className="list__item">
                <div>
                  <strong>{t.name}</strong>{' '}
                  <span className="mono muted">{t.id}</span>{' '}
                  <span className={`badge badge--${t.status === 'active' ? 'approved' : t.status === 'suspended' ? 'deploying' : 'failed'}`}>
                    {t.status}
                  </span>{' '}
                  <span className="badge">{t.plan}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    slug: {t.slug} · 创建于 {new Date(t.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="form__actions" style={{ marginTop: 0 }}>
                  {t.status === 'active' && (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(t, 'suspend')}>
                      停用
                    </Button>
                  )}
                  {t.status === 'suspended' && (
                    <Button size="sm" onClick={() => setStatus(t, 'resume')}>
                      恢复
                    </Button>
                  )}
                  {t.status !== 'purged' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(t);
                        setEditPlan(t.plan);
                        setEditQuotas(JSON.stringify(t.quotas ?? {}, null, 2));
                      }}
                    >
                      套餐/配额
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && (
        <Card title={`套餐/配额 — ${editing.name}（${editing.id}）`}>
          <div className="form__inline">
            <label className="form__label">
              套餐
              <select value={editPlan} onChange={(e) => setEditPlan(e.target.value)}>
                <option value="trial">trial</option>
                <option value="professional">professional</option>
                <option value="enterprise">enterprise</option>
              </select>
            </label>
            <TextField label="配额 JSON（null=不限）" value={editQuotas} onChange={(e) => setEditQuotas(e.target.value)} />
          </div>
          <div className="form__actions">
            <Button onClick={savePlan}>保存</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
