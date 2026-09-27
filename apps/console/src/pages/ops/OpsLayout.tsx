import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useOpsAuth } from '../../auth/OpsAuthContext';
import { Button } from '../../components/ui/Button';
import './ops.css';

/** 平台运营后台布局：独立导航，与租户控制台隔离 */
export function OpsLayout() {
  const { logout } = useOpsAuth();
  const navigate = useNavigate();

  const quit = () => {
    logout();
    navigate('/ops/login', { replace: true });
  };

  return (
    <div className="ops-shell">
      <aside className="ops-shell__side">
        <div className="ops-shell__brand">平台运营后台</div>
        <nav className="ops-shell__nav">
          <NavLink to="/ops/tenants" className={({ isActive }) => (isActive ? 'is-active' : '')}>
            租户管理
          </NavLink>
          <NavLink to="/ops/offboard" className={({ isActive }) => (isActive ? 'is-active' : '')}>
            租户销户
          </NavLink>
          <NavLink to="/ops/audit" className={({ isActive }) => (isActive ? 'is-active' : '')}>
            审计与合规
          </NavLink>
          <NavLink to="/ops/platform" className={({ isActive }) => (isActive ? 'is-active' : '')}>
            平台运维
          </NavLink>
        </nav>
        <div className="ops-shell__foot">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            租户控制台
          </Button>
          <Button variant="ghost" size="sm" onClick={quit}>
            退出运维
          </Button>
        </div>
      </aside>
      <main className="ops-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
