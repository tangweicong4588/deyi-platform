import type { InputHTMLAttributes } from 'react';
import './TextField.css';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextField({ label, error, hint, id, ...rest }: Props) {
  const inputId = id ?? `tf-${label}`;
  return (
    <div className="dy-field">
      <label className="dy-field__label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className={`dy-field__input${error ? ' dy-field__input--error' : ''}`}
        aria-invalid={!!error}
        {...rest}
      />
      {error ? <div className="dy-field__error" role="alert">{error}</div>
        : hint ? <div className="dy-field__hint">{hint}</div> : null}
    </div>
  );
}
