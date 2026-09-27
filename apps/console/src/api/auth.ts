import { post, get } from './client';

/** V2.10 真实登录：POST /v1/auth/login { tenant, username, password, totpCode? } */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  actor: { id: string; name: string; kind: string };
  tenant: { id: string; slug: string };
}

export function login(tenant: string, username: string, password: string, totpCode?: string): Promise<LoginResult> {
  return post<LoginResult>('/v1/auth/login', { tenant, username, password, totpCode: totpCode || undefined });
}

export interface Me {
  actor: { id: string; kind: string; name: string };
  tenant: { id: string; name: string; slug: string } | null;
  authKind: string;
  roles: Array<{ project_id: string | null; role: string }>;
}

/** GET /v1/me（F0 的 POST /v1/auth/me 只是 mock 壳，已废弃） */
export function fetchMe(token: string): Promise<Me> {
  return get<Me>('/v1/me', { token });
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  status: string;
}

export function listProjects(token: string): Promise<Project[]> {
  return get<Project[]>('/v1/projects', { token });
}

/** TOTP 未通过时后端返回 401 + details.code=TOTP_REQUIRED */
export function isTotpRequired(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    (e as { status: number }).status === 401 &&
    'details' in e &&
    typeof (e as { details?: unknown }).details === 'object' &&
    (e as { details: { code?: string } }).details?.code === 'TOTP_REQUIRED'
  );
}
