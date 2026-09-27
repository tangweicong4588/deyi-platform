import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { tasksApi } from '../api/console';
import type { BizTask } from '../api/console';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Spinner } from '../components/ui/Spinner';

const KIND_LABEL: Record<string, string> = { ticket: '工单', approval: '审批单', doc_task: '文档任务' };

export function TasksPage() {
  const { token, projectId } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<BizTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState('ticket');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await tasksApi.list(token, projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !title.trim()) return;
    setCreating(true);
    try {
      await tasksApi.create(token, projectId, { kind, title: title.trim(), description: description.trim() });
      setTitle(''); setDescription(''); setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h2>业务任务</h2>
        <Button onClick={() => setShowForm((v) => !v)}>发起任务</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {showForm && (
        <Card title="发起任务">
          <form onSubmit={onCreate} className="form-card">
            <label className="muted">类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="ticket">工单</option>
                <option value="approval">审批单</option>
                <option value="doc_task">文档任务</option>
              </select>
            </label>
            <TextField label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label className="muted">描述
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <Button type="submit" loading={creating}>创建</Button>
          </form>
        </Card>
      )}
      {loading ? <Spinner /> : (
        <div className="page-grid">
          {items.length === 0 && <p className="muted">暂无任务</p>}
          {items.map((t) => (
            <Card key={t.id}>
              <div className="list-item">
                <div>
                  <div className="list-item__title">{t.title}</div>
                  <div className="list-item__meta">
                    {KIND_LABEL[t.kind] ?? t.kind} · {t.priority}{t.escalated ? ' · 已升级' : ''}
                  </div>
                </div>
                <div className="row">
                  <span className="status-pill">{t.status}</span>
                  <button type="button" className="link-btn" onClick={() => navigate(`/tasks/${t.id}`)}>详情</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
