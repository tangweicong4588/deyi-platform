import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { memoryApi } from '../api/console';
import type { MemoryItem } from '../api/console';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';

export function MemoryPage() {
  const { token, me } = useAuth();
  const tenantId = me?.tenant?.id ?? null;
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [mode, setMode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  const doRecall = useCallback(async (q: string) => {
    if (!token || !tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await memoryApi.recall(token, tenantId, q || '*', 20);
      setItems(r?.items ?? []);
      setMode(r?.mode ?? '');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '检索失败');
    } finally {
      setLoading(false);
    }
  }, [token, tenantId]);

  useEffect(() => { void doRecall(''); }, [doRecall]);

  const onRemember = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !tenantId || !content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await memoryApi.remember(token, tenantId, { content: content.trim(), visibility: 'private' });
      setContent('');
      await doRecall(query);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '写入失败');
    } finally {
      setSaving(false);
    }
  };

  const onForget = async (id: string) => {
    if (!token || !tenantId) return;
    try {
      await memoryApi.forget(token, tenantId, id);
      await doRecall(query);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    }
  };

  return (
    <div>
      <div className="page-head"><h2>记忆</h2></div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="page-grid">
        <Card title="写记忆">
          <form onSubmit={onRemember} className="form-card">
            <label className="muted">内容
              <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="例如：客户偏好在周五下午开例会" />
            </label>
            <Button type="submit" loading={saving}>记住</Button>
          </form>
        </Card>

        <Card title={`检索${mode ? `（${mode}）` : ''}`}>
          <form onSubmit={(e) => { e.preventDefault(); void doRecall(query); }} className="row">
            <TextField label="关键词" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" loading={loading}>检索</Button>
          </form>
          <div style={{ marginTop: 12 }}>
            {items.length === 0 && !loading && <p className="muted">暂无记忆</p>}
            {items.map((m) => (
              <div key={m.id} className="list-item" style={{ borderBottom: '1px solid #edf0f5', padding: '8px 0' }}>
                <div>
                  <div className="list-item__title" style={{ fontWeight: 400 }}>{m.content}</div>
                  <div className="list-item__meta">{m.kind} · {m.visibility} · {new Date(m.created_at).toLocaleString()}</div>
                </div>
                <button type="button" className="link-btn danger" onClick={() => void onForget(m.id)}>遗忘</button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
