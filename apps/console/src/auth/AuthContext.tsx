import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { login as apiLogin, fetchMe, listProjects } from '../api/auth';
import type { Me, Project } from '../api/auth';

const TOKEN_KEY = 'deyi.console.access_token';
const PROJECT_KEY = 'deyi.console.project_id';

interface AuthState {
  token: string | null;
  me: Me | null;
  projects: Project[];
  projectId: string | null;
  /** 项目列表是否已加载完成（用于区分"加载中"与"租户确实没有项目"） */
  projectsLoaded: boolean;
  login: (tenant: string, username: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => void;
  selectProject: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * 鉴权（F1 接真实后端）：
 * - accessToken 存 localStorage（15min 有效；refresh 续期在 F2 接）
 * - 登录后拉取 /v1/me 与项目列表，默认选中上次或第一个项目
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(() => localStorage.getItem(PROJECT_KEY));

  const loadSession = useCallback(async (t: string) => {
    const m = await fetchMe(t);
    setMe(m);
    try {
      const ps = await listProjects(t);
      setProjects(ps);
      setProjectId((prev) => {
        const saved = localStorage.getItem(PROJECT_KEY);
        const ok = (id: string | null) => id && ps.some((p) => p.id === id);
        const next = ok(prev) ? prev! : ok(saved) ? saved! : ps[0]?.id ?? null;
        if (next) localStorage.setItem(PROJECT_KEY, next);
        return next;
      });
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (token) loadSession(token).catch(() => {});
  }, [token, loadSession]);

  const login = useCallback(
    async (tenant: string, username: string, password: string, totpCode?: string) => {
      const r = await apiLogin(tenant.trim(), username.trim(), password, totpCode);
      localStorage.setItem(TOKEN_KEY, r.accessToken);
      setToken(r.accessToken);
      await loadSession(r.accessToken);
    },
    [loadSession],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setMe(null);
    setProjects([]);
    setProjectsLoaded(false);
    setProjectId(null);
  }, []);

  const selectProject = useCallback((id: string) => {
    localStorage.setItem(PROJECT_KEY, id);
    setProjectId(id);
  }, []);

  const value = useMemo(
    () => ({ token, me, projects, projectId, projectsLoaded, login, logout, selectProject }),
    [token, me, projects, projectId, projectsLoaded, login, logout, selectProject],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return v;
}
