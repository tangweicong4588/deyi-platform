import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { artifactsApi } from '../../api/deliver';
import type { ArtifactPackage, ArtifactVersion } from '../../api/deliver';
import { ApiError } from '../../api/client';
import { Card } from '../../components/ui/Card';
import './deliver.css';
import { NoProjectHint } from '../../components/NoProjectHint';
import { TextField } from '../../components/ui/TextField';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';

export function ArtifactsPage() {
  const { token, projectId, projectsLoaded } = useAuth();
  const [packages, setPackages] = useState<ArtifactPackage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!token || !projectId) return;
    setLoading(true); setError(null);
    try {
      setPackages((await artifactsApi.listPackages(token, projectId)) ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally { setLoading(false); }
  }, [token, projectId]);

  const loadVersions = useCallback(async (pkgId: string) => {
    if (!token || !projectId) return;
    try { setVersions((await artifactsApi.listVersions(token, projectId, pkgId)) ?? []); }
    catch (e) { setError(e instanceof ApiError ? e.message : '加载版本失败'); }
  }, [token, projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selected) void loadVersions(selected); }, [selected, loadVersions]);
  if (projectsLoaded && !projectId) return <NoProjectHint pageName="制品库" />;

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !projectId || !name.trim()) return;
    setBusy(true);
    try {
      const p = await artifactsApi.createPackage(token, projectId, { name: name.trim() });
      setName(''); setShowForm(false); await load(); setSelected(p.id);
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : '创建失败');
    } finally { setBusy(false); }
  };

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!token || !projectId || !selected || !file) return;
    setUploading(true); setError(null);
    try {
      await artifactsApi.uploadVersion(token, projectId, selected, file);
      if (fileRef.current) fileRef.current.value = '';
      await loadVersions(selected);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '上传失败');
    } finally { setUploading(false); }
  };

  const sel = packages.find((p) => p.id === selected);

  const onDownload = async (v: ArtifactVersion) => {
    if (!token || !projectId || !sel) return;
    setError(null);
    try {
      const res = await fetch(artifactsApi.downloadUrl(projectId, sel.id, v.version), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`下载失败（${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${sel.name}-${v.version}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
    }
  };
  return (
    <div className="page">
      <div className="page__head">
        <h2>制品库</h2>
        <Button onClick={() => setShowForm((v) => !v)}>{showForm ? '取消' : '新建制品包'}</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {showForm && (
        <Card title="新建制品包">
          <form onSubmit={onCreate}>
            <TextField label="包名" value={name} onChange={(e) => setName(e.target.value)} required />
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? '创建中…' : '创建'}</Button>
          </form>
        </Card>
      )}
      {loading ? <Spinner /> : (
        <div className="grid2">
          <Card title="制品包">
            {packages.length === 0 ? <p className="muted">暂无制品包</p> : (
              <ul className="list">
                {packages.map((p) => (
                  <li key={p.id} className={`list__item${selected === p.id ? ' is-selected' : ''}`}
                      onClick={() => setSelected(p.id)} style={{ cursor: 'pointer' }}>
                    <strong>{p.name}</strong>
                    <span className="muted">{p.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={sel ? `版本 · ${sel.name}` : '版本'}>
            {!sel ? <p className="muted">先选择左侧制品包</p> : (
              <>
                <div className="form__row">
                  <input ref={fileRef} type="file" />
                  <Button size="sm" onClick={onUpload} disabled={uploading}>{uploading ? '上传中…' : '上传新版本'}</Button>
                </div>
                {versions.length === 0 ? <p className="muted">暂无版本</p> : (
                  <ul className="list">
                    {versions.map((v) => (
                      <li key={v.version} className="list__item">
                        <div>
                          <strong>{v.version}</strong>
                          <span className="muted"> · {(v.size_bytes / 1024).toFixed(1)} KB · {v.content_hash.slice(0, 12)}…{v.pinned ? ' · 已锁定' : ''}</span>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => onDownload(v)}>下载</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
