import './Alert.css';

type Tone = 'info' | 'success' | 'warning' | 'danger';

export function Alert({ tone = 'info', children }: { tone?: Tone; children: React.ReactNode }) {
  return <div className={`dy-alert dy-alert--${tone}`} role="alert">{children}</div>;
}
