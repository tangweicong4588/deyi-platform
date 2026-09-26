#!/usr/bin/env bash
# deploy/smoke.sh —— 部署后冒烟验证（部署机上执行）
#
# 用法：
#   OPERATOR_TOKEN=xxx ./smoke.sh [--strict]
#   API=http://localhost:8080 OPERATOR_TOKEN=xxx ./smoke.sh --strict
#
# --strict：生产验收模式，adapters 出现 fallback 即判失败（默认只告警）
#
# 覆盖：
#   1. /healthz 存活；2. /readyz 就绪 + 适配器状态；3. 原子开通租户；
#   4. 租户 Key 鉴权；5. 停用→401→恢复 完整生命周期。
# 不覆盖：模型真实调用（费 token，手工按 runbook 验证）、K8s 探针（由 kubelet 执行）。
set -u
API="${API:-http://localhost:8080}"
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

[ -z "${OPERATOR_TOKEN:-}" ] && { echo "FAIL: 未设置 OPERATOR_TOKEN"; exit 1; }
command -v python3 >/dev/null || { echo "FAIL: 需要 python3 解析 JSON"; exit 1; }
command -v curl >/dev/null || { echo "FAIL: 需要 curl"; exit 1; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
warn() { echo "WARN: $1"; }

# 1. 存活
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/healthz")" = "200" ] \
  && ok "/healthz 200" || bad "/healthz 非 200"

# 2. 就绪 + 适配器
READYZ="$(curl -s -w '\n%{http_code}' "$API/readyz")"
CODE="$(echo "$READYZ" | tail -1)"; BODY="$(echo "$READYZ" | sed '$d')"
[ "$CODE" = "200" ] && ok "/readyz 200" || { bad "/readyz $CODE"; echo "$BODY"; }
echo "--- adapters ---"; echo "$BODY" | python3 -m json.tool 2>/dev/null | sed -n '/adapters/,/}/p' | head -15

# 生产硬性要求（strict 才判失败，否则只告警）
require_live() { # $1=key $2=期望值
  local v; v="$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['adapters']['$1'])" 2>/dev/null)"
  if [ "$v" = "$2" ]; then ok "adapters.$1=$v";
  elif [ "$STRICT" = "1" ]; then bad "adapters.$1=$v（期望 $2）";
  else warn "adapters.$1=$v（期望 $2）"; fi
}
require_live database "postgresql(live)"
require_live idp "keycloak(live)"
require_live model_gateway "litellm(live)"
require_live vector "qdrant(live)"
require_live audit_anchor "configured"

# 3. 原子开通
TS="$(date +%s)"
PROV="$(curl -s -X POST "$API/v1/admin/tenants/provision" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"smoke-$TS\",\"adminName\":\"smoke-admin\"}")"
TID="$(echo "$PROV" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['tenant']['id'])" 2>/dev/null)"
TKEY="$(echo "$PROV" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['apiKey']['key'])" 2>/dev/null)"
if [ -n "$TID" ] && [ -n "$TKEY" ]; then ok "原子开通租户 $TID";
else bad "原子开通失败: $(echo "$PROV" | head -c 300)"; fi

# 4. 租户 Key 鉴权
if [ -n "${TKEY:-}" ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/me" -H "Authorization: Bearer $TKEY")" = "200" ] \
    && ok "租户 Key 鉴权通过" || bad "租户 Key 鉴权失败"
fi

# 5. 停用 → 401 → 恢复
if [ -n "${TID:-}" ]; then
  S1="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/admin/tenants/$TID/suspend" \
    -H "Authorization: Bearer $OPERATOR_TOKEN")"
  [ "$S1" = "200" ] && ok "租户停用" || bad "租户停用 $S1"
  sleep 1
  C1="$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/me" -H "Authorization: Bearer $TKEY")"
  [ "$C1" = "401" ] && ok "停用后 Key 立即 401" || bad "停用后 Key 未失效（$C1）"
  R1="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/admin/tenants/$TID/resume" \
    -H "Authorization: Bearer $OPERATOR_TOKEN")"
  [ "$R1" = "200" ] && ok "租户恢复" || bad "租户恢复 $R1"
  C2="$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/me" -H "Authorization: Bearer $TKEY")"
  [ "$C2" = "200" ] && ok "恢复后 Key 可用" || bad "恢复后 Key 仍不可用（$C2）"
fi

echo "================== smoke: PASS=$PASS FAIL=$FAIL =================="
[ "$FAIL" = "0" ]
