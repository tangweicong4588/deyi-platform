import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useOpsAuth } from './OpsAuthContext';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Alert } from '../components/ui/Alert';
import { Card } from '../components/ui/Card';

/** 运维登录页：粘贴 OPERATOR_TOKEN */
export function OpsLoginPage() {
  const { token, login } = useOpsAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/ops/tenants';

  if (token) return <Navigate to={from} replace />;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await login(value);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-login">
      <Card title="平台运营后台">
        <p className="muted">
          粘贴控制面的 <span className="mono">OPERATOR_TOKEN</span> 进入。该密钥拥有全平台租户的运维权限（含销户），请妥善保管。
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="form__row">
          <TextField
            label="OPERATOR_TOKEN"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="粘贴运维密钥"
            type="password"
            autoComplete="off"
          />
        </div>
        <div className="form__actions">
          <Button onClick={submit} disabled={busy || !value.trim()}>
            {busy ? '校验中…' : '进入运营后台'}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/login')}>
            返回租户控制台
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** 运维路由守卫：无 token → /ops/login */
export function OpsProtectedRoute({ children }: { children: ReactNode }) {
  const { token } = useOpsAuth();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/ops/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
