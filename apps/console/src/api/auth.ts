import { post } from './client';

export interface LoginResult {
  token: string;
  user: { id: string; name: string; email?: string };
}

/** V2.10 身份服务：用户名密码登录（TOTP 二次校验在 F1 接入，此处为壳） */
export function login(username: string, password: string): Promise<LoginResult> {
  return post<LoginResult>('/v1/auth/login', { username, password });
}

export interface Me {
  actor: { id: string; kind: string; name: string };
  tenant: { id: string; name: string } | null;
}

export function fetchMe(token: string): Promise<Me> {
  return post<Me>('/v1/auth/me', undefined, { token });
}
