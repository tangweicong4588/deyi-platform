import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { opsApi } from '../api/ops';

const OPS_TOKEN_KEY = 'deyi.console.operator_token';

interface OpsAuthState {
  token: string | null;
  /** 粘贴 OPERATOR_TOKEN 并校验（调一次租户列表确认有效） */
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const OpsAuthContext = createContext<OpsAuthState | null>(null);

/**
 * 平台运营鉴权（F4）：OPERATOR_TOKEN 是平台级共享密钥，由运维粘贴录入，
 * 存 localStorage。校验方式是调一次 /v1/admin/tenants，401/403 即 token 无效。
 */
export function OpsAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(OPS_TOKEN_KEY));

  const login = useCallback(async (t: string) => {
    const trimmed = t.trim();
    if (!trimmed) throw new Error('请粘贴 OPERATOR_TOKEN');
    await opsApi.listTenants(trimmed); // 校验有效性
    localStorage.setItem(OPS_TOKEN_KEY, trimmed);
    setToken(trimmed);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(OPS_TOKEN_KEY);
    setToken(null);
  }, []);

  const value = useMemo(() => ({ token, login, logout }), [token, login, logout]);
  return <OpsAuthContext.Provider value={value}>{children}</OpsAuthContext.Provider>;
}

export function useOpsAuth(): OpsAuthState {
  const ctx = useContext(OpsAuthContext);
  if (!ctx) throw new Error('useOpsAuth 必须在 OpsAuthProvider 内使用');
  return ctx;
}
