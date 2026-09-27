import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import './DashboardPage.css';

export function DashboardPage() {
  const { me, logout } = useAuth();
  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1>得逸智行控制台</h1>
        <Button variant="ghost" size="sm" onClick={logout}>退出登录</Button>
      </header>
      <main className="dashboard__main">
        <Card title="基座就绪">
          <p>
            欢迎，{me?.actor?.name ?? '用户'}。
            {me?.tenant ? `当前租户：${me.tenant.name}` : '（未绑定租户）'}
          </p>
          <p className="dashboard__hint">
            F0 只交付前端基建（脚手架 / tokens / 组件基座 / 路由鉴权壳 / API client / MSW）。
            业务页面（任务、知识库、记忆、账单、运营后台）随 F1–F4 迭代接入真实后端。
          </p>
        </Card>
      </main>
    </div>
  );
}
