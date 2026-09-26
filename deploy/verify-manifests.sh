#!/usr/bin/env bash
# deploy/verify-manifests.sh —— 部署产物静态自洽检查（无需 Docker，提交前/部署前跑）
#
# 检查：
#  1. deploy/.env.example 与 compose/k8s 引用的变量名一致（无拼写漂移）
#  2. compose 卷挂载的宿主机路径存在
#  3. litellm/config.yaml 有合法 model_list
#  4. k8s workload 引用的 configmap/secret 键全部存在（optional 除外）
#  5. .env.example 无真实密钥残留（只允许 CHANGEME_/空值/注释示例 URL）
set -u
cd "$(dirname "$0")"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# 1. compose 变量 vs .env.example
VARS_COMPOSE="$(grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' docker-compose.yml | tr -d '${}' | sort -u)"
VARS_EXAMPLE="$(grep -o '^[A-Za-z_][A-Za-z0-9_]*=' .env.example | tr -d '=' | sort -u)"
MISSING=""
for v in $VARS_COMPOSE; do
  echo "$VARS_EXAMPLE" | grep -qx "$v" || MISSING="$MISSING $v"
done
[ -z "$MISSING" ] && ok "compose 变量在 .env.example 都有定义" || bad "compose 变量缺定义:$MISSING"

# 2. 卷挂载路径
MISSING_VOL=""
while read -r src; do
  [ -e "$src" ] || MISSING_VOL="$MISSING_VOL $src"
done < <(python3 -c "
import yaml, os
d = yaml.safe_load(open('docker-compose.yml'))
for s in d['services'].values():
    for v in s.get('volumes') or []:
        src = str(v).split(':')[0]
        if src.startswith('./') or src.startswith('../'):
            print(os.path.normpath(src))
" | sort -u)
[ -z "$MISSING_VOL" ] && ok "compose 卷挂载路径都存在" || bad "卷路径缺失:$MISSING_VOL"

# 3. litellm model_list
python3 -c "
import yaml, sys
c = yaml.safe_load(open('litellm/config.yaml'))
ml = c.get('model_list') or []
assert ml, 'model_list 为空'
for m in ml:
    assert m.get('model_name') and (m.get('litellm_params') or {}).get('model'), f'模型条目缺字段: {m}'
print(f'model_list {len(ml)} 条合法')
" && ok "litellm/config.yaml model_list 合法" || bad "litellm/config.yaml 非法"

# 4. k8s 键引用
python3 << 'PYEOF' || bad "k8s 键引用缺失（见上）"
import yaml, glob, sys
cm_keys, sec_keys = set(), set()
for f in glob.glob('k8s/*.yaml'):
    for doc in yaml.safe_load_all(open(f)):
        if not doc: continue
        if doc.get('kind') == 'ConfigMap' and doc['metadata']['name'] == 'deyi-config':
            cm_keys |= set(doc.get('data', {}).keys())
        if doc.get('kind') == 'Secret' and doc['metadata']['name'] == 'deyi-secrets':
            sec_keys |= set((doc.get('stringData') or {}).keys())
problems = []
for f in glob.glob('k8s/**/*.yaml', recursive=True):
    for doc in yaml.safe_load_all(open(f)):
        if not doc: continue
        spec = doc.get('spec') or {}
        tmpl = (spec.get('template') or {}).get('spec') or spec
        for c in (tmpl.get('containers') or []) + (tmpl.get('initContainers') or []):
            for e in c.get('env') or []:
                vr = e.get('valueFrom') or {}
                if 'configMapKeyRef' in vr:
                    r = vr['configMapKeyRef']
                    if r['name'] == 'deyi-config' and r['key'] not in cm_keys and not r.get('optional'):
                        problems.append(f"{f}: {e['name']} -> configmap 缺键 {r['key']}")
                if 'secretKeyRef' in vr:
                    r = vr['secretKeyRef']
                    if r['name'] == 'deyi-secrets' and r['key'] not in sec_keys and not r.get('optional'):
                        problems.append(f"{f}: {e['name']} -> secret 缺键 {r['key']}")
if problems:
    print('\n'.join(problems)); sys.exit(1)
print(f'k8s 键引用齐备（configmap {len(cm_keys)} 键，secret {len(sec_keys)} 键）')
PYEOF
[ $? -eq 0 ] && ok "k8s configmap/secret 键引用齐备" || true

# 5. .env.example 无真值（只允许 CHANGEME_、空值、已知非敏感键）
LEAK="$(grep -v '^#' .env.example | grep -v '^$' | grep -E '^[A-Za-z_]+=.+' | grep -v 'CHANGEME' | grep -v '=$' \
  | grep -v -E '^(DEYI_ENV|PORT|HOST)=' || true)"
[ -z "$LEAK" ] && ok ".env.example 无真实密钥残留" || bad "疑似真值:\n$LEAK"

echo "================== verify-manifests: PASS=$PASS FAIL=$FAIL =================="
[ "$FAIL" = "0" ]
