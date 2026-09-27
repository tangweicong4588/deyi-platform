import { useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import './LoginPage.css';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <Card title="得逸智行控制台">
        <p className="login-page__sub">企业级 AI 交付与执行平台</p>
        {import.meta.env.VITE_USE_MOCK === 'true' && (
          <Alert tone="info">当前为 Mock 模式（MSW），任意用户名/密码可登录；用户名 locked 模拟账号锁定。</Alert>
        )}
        <form onSubmit={onSubmit} className="login-page__form">
          <TextField label="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <TextField label="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={submitting}>登录</Button>
        </form>
      </Card>
    </div>
  );
}
