import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { tasksApi } from '../api/console';
import type { BizTaskDetail } from '../api/console';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';

// 状态机可达后继（与后端 TRANSITIONS 对齐的常用推进）
const NEXTS: Record<string, string[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['pending', 'resolved', 'cancelled'],
  pending: ['in_progress', 'resolved', 'cancelled'],
  resolved: ['closed'],
  closed: [],
  cancelled: [],
};

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { token, projectId } = useAuth();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BizTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId || !taskId) return;
    setLoading(true);
    try {
      setDetail(await tasksApi.get(token, projectId, taskId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, projectId, taskId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    if (!token || !projectId || !taskId) return;
    setActing(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setActing(false);
    }
  };

  if (loading) return <Spinner />;
  if (!detail) return <Alert tone="danger">{error ?? '任务不存在'}</Alert>;
  const { task, transitions } = detail;

  return (
    <div>
      <div className="page-head">
        <h2>{task.title}</h2>
        <Button onClick={() => navigate('/tasks')}>返回列表</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="page-grid">
        <Card title="基本信息">
          <p className="muted">类型 {task.kind} · 状态 <span className="status-pill">{task.status}</span> · 优先级 {task.priority}</p>
          <p>{task.description || <span className="muted">无描述</span>}</p>
        </Card>

        <Card title="推进状态">
          <div className="row">
            <TextField label="备注" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {(NEXTS[task.status] ?? []).map((to) => (
              <Button key={to} disabled={acting} onClick={() => void act(() => tasksApi.transition(token!, projectId!, taskId!, to, note || undefined))}>
                → {to}
              </Button>
            ))}
            {(NEXTS[task.status] ?? []).length === 0 && <span className="muted">已处终态</span>}
          </div>
        </Card>

        {task.kind === 'approval' && (task.status === 'open' || task.status === 'pending') && (
          <Card title="审批">
            <div className="row">
              <Button disabled={acting} onClick={() => void act(() => tasksApi.decide(token!, projectId!, taskId!, true, note || undefined))}>
                通过
              </Button>
              <Button disabled={acting} onClick={() => void act(() => tasksApi.decide(token!, projectId!, taskId!, false, note || undefined))}>
                驳回
              </Button>
            </div>
            <p className="muted">SoD：发起人不能审批自己的审批单（后端强制）。</p>
          </Card>
        )}

        <Card title="流转记录">
          {transitions.length === 0 && <p className="muted">暂无流转记录</p>}
          <table className="data">
            <thead><tr><th>从</th><th>到</th><th>备注</th><th>时间</th></tr></thead>
            <tbody>
              {transitions.map((tr) => (
                <tr key={tr.id}>
                  <td>{tr.from_status}</td><td>{tr.to_status}</td>
                  <td>{tr.note ?? '-'}</td>
                  <td>{new Date(tr.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
