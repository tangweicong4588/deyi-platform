import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './AppLayout.css';

const NAV = [
  { to: '/tasks', label: '业务任务' },
  { to: '/knowledge', label: '知识库' },
  { to: '/memory', label: '记忆' },
  { to: '/usage', label: '用量' },
];

export function AppLayout() {
  const { me, projects, projectId, selectProject, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="layout">
      <aside className="layout__side">
        <div className="layout__brand">得逸智行</div>
        <nav className="layout__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `layout__link${isActive ? ' is-active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="layout__foot">
          <div className="layout__who">
            <div className="layout__who-name">{me?.actor.name ?? '-'}</div>
            <div className="layout__who-tenant">{me?.tenant?.name ?? ''}</div>
          </div>
          <label className="layout__proj">
            <span>项目</span>
            <select value={projectId ?? ''} onChange={(e) => selectProject(e.target.value)}>
              {projects.length === 0 && <option value="" disabled>暂无项目</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="layout__logout" onClick={onLogout}>退出登录</button>
        </div>
      </aside>
      <main className="layout__main">
        <Outlet />
      </main>
    </div>
  );
}
