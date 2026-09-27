import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { login as apiLogin, fetchMe } from '../api/auth';
import type { Me } from '../api/auth';

const TOKEN_KEY = 'deyi.console.token';

interface AuthState {
  token: string | null;
  me: Me | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * 鉴权壳。F0 为可跑通的壳：
 * - token 暂存 localStorage（接 mock 可登录；生产联调前应换 httpOnly cookie 或内存+refresh，见 README 边界说明）
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [me, setMe] = useState<Me | null>(null);

  const login = useCallback(async (username: string, password: string) => {
    const r = await apiLogin(username, password);
    localStorage.setItem(TOKEN_KEY, r.token);
    setToken(r.token);
    try {
      setMe(await fetchMe(r.token));
    } catch {
      setMe(null);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setMe(null);
  }, []);

  const value = useMemo(() => ({ token, me, login, logout }), [token, me, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return v;
}
