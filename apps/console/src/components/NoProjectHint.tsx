import { Card } from './ui/Card';
import { Button } from './ui/Button';

/**
 * 零项目空状态：租户下没有任何项目（或当前用户未被分配到任何项目）时，
 * 各业务页用它代替无限转圈，明确告诉用户下一步该做什么。
 */
export function NoProjectHint({ pageName }: { pageName: string }) {
  return (
    <div>
      <div className="page-head">
        <h2>{pageName}</h2>
      </div>
      <Card title="还没有可用项目">
        <p className="muted">当前租户下没有任何项目，或你尚未被分配到任何项目，所以这里没有内容可显示。</p>
        <p className="muted">
          请联系租户管理员完成开户：先创建项目
          （<code>POST /v1/admin/tenants/&lt;tenantId&gt;/projects</code>），
          再为你绑定项目角色
          （<code>POST /v1/admin/tenants/&lt;tenantId&gt;/role-bindings</code>），
          然后刷新本页。
        </p>
        <Button onClick={() => window.location.reload()}>刷新</Button>
      </Card>
    </div>
  );
}
