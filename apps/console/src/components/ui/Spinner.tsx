import './Spinner.css';

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="dy-spinner" role="status" aria-label={label}>
      <span className="dy-spinner__ring" aria-hidden />
      <span className="dy-spinner__label">{label}</span>
    </div>
  );
}
