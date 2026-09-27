import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { knowledgeApi } from '../api/console';
import type { KnowledgeDoc } from '../api/console';
import { ApiError } from '../api/client';
import { Card } from '../components/ui/Card';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Spinner } from '../components/ui/Spinner';

export function KnowledgePage() {
  const { token, projectId } = useAuth();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ docId: string; title: string; score: number; snippet: string }> | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true);
    try {
      setDocs(await knowledgeApi.list(token, projectId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);

  const onIngest = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !title.trim() || !content.trim()) return;
    setIngesting(true);
    setError(null);
    try {
      await knowledgeApi.ingest(token, projectId, { title: title.trim(), content: content.trim() });
      setTitle(''); setContent('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '入库失败');
    } finally {
      setIngesting(false);
    }
  };

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await knowledgeApi.search(token, projectId, query.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '检索失败');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <div className="page-head"><h2>知识库</h2></div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="page-grid">
        <Card title="检索">
          <form onSubmit={onSearch} className="row">
            <TextField label="关键词" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" loading={searching}>搜索</Button>
          </form>
          {hits && (
            <div style={{ marginTop: 12 }}>
              {hits.length === 0 && <p className="muted">无结果</p>}
              {hits.map((h) => (
                <div key={h.docId} style={{ marginBottom: 8 }}>
                  <div className="list-item__title">{h.title} <span className="muted">({h.score.toFixed(3)})</span></div>
                  <div className="muted">{h.snippet}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="入库文档">
          <form onSubmit={onIngest} className="form-card">
            <TextField label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label className="muted">内容（Markdown）
              <textarea value={content} onChange={(e) => setContent(e.target.value)} />
            </label>
            <Button type="submit" loading={ingesting}>入库</Button>
          </form>
        </Card>

        <Card title="文档列表">
          {loading ? <Spinner /> : docs.length === 0 ? <p className="muted">暂无文档</p> : (
            <table className="data">
              <thead><tr><th>标题</th><th>状态</th><th>版本</th><th>创建时间</th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td><td>{d.status}</td><td>v{d.version}</td>
                    <td>{new Date(d.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
