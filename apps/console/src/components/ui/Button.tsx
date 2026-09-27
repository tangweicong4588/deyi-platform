import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, children, ...rest }: Props) {
  return (
    <button
      className={`dy-btn dy-btn--${variant} dy-btn--${size}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="dy-btn__spinner" aria-hidden />}
      {children}
    </button>
  );
}
