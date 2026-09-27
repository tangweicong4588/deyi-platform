/**
 * modules/openapi/routes.mjs —— V2.9：GET /v1/openapi.json。
 *
 * 规范按请求实时从路由表生成（保证与实现一致）；本路由自身不计入规范。
 * 需要任意有效凭证（operator / API Key / JWT）：规范中含管理面路径，默认不公开。
 */
import { sendJson } from '../../kernel/http.mjs';
import { authenticate } from '../identity/middleware.mjs';
import { buildOpenApi } from './spec.mjs';

export const OPENAPI_PATH = '/v1/openapi.json';

export function registerOpenApiRoutes(app) {
  app.get(OPENAPI_PATH, authenticate, async (req, res) => {
    const routes = app.routes().filter((r) => r.path !== OPENAPI_PATH);
    sendJson(res, 200, buildOpenApi(routes));
  });
}
