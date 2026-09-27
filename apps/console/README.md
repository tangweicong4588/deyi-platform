# 得逸智行控制台前端（@deyi/console）

F0 前端基建：React 19 + Vite 7 + TypeScript（strict）+ react-router-dom。

## 目录

- `src/styles/tokens.css` — 设计 tokens（品牌色 / 间距 / 圆角 / 字体），组件只引用变量
- `src/components/ui/` — 组件基座：Button / TextField / Card / Alert / Spinner
- `src/api/client.ts` — 类型化 fetch 封装：解包后端 `{ data }` 信封，错误抛 `ApiError(status/code/message)`
- `src/api/auth.ts` — 登录 / me 接口
- `src/auth/` — `AuthProvider` + `ProtectedRoute` 路由鉴权壳
- `src/pages/` — `LoginPage` / `DashboardPage`（壳）
- `src/mocks/` — MSW handlers（仅开发/演示）

## 本地开发

```bash
pnpm --filter @deyi/console dev   # http://127.0.0.1:5173，默认走 MSW mock
pnpm --filter @deyi/console build # tsc -b + vite build
```

`.env.development` 默认 `VITE_USE_MOCK=true`（不依赖后端即可跑登录壳）。
联调后端时：`VITE_USE_MOCK=false` + `VITE_API_BASE_URL=http://127.0.0.1:8080`。

## 诚实边界（F0）

1. **登录壳 ≠ 真实鉴权联调**：当前用 MSW mock `/v1/auth/login`、`/v1/auth/me`；
   真实登录需后端 V2.10 身份服务在线，且 TOTP 二次校验尚未接入（F1）。
2. **token 暂存 localStorage**：为 mock 演示方便；生产联调前必须换 httpOnly
   cookie 或内存 token + refresh 轮换，否则有 XSS 窃取风险。
3. **mockServiceWorker.js**：`public/mockServiceWorker.js` 由 msw 包复制而来；
   升级 msw 版本后需重新复制（`msw init public`，本仓库直接从包内复制）。
4. **业务页面尚未实现**：任务、知识库、记忆、账单、运营后台随 F1–F4 接入。
5. **无单测**：F0 验收为 `pnpm build` 通过 + 浏览器登录冒烟；组件单测随 F1 补。
