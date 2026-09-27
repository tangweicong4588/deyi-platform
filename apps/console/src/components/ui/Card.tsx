import type { ReactNode } from 'react';
import './Card.css';

export function Card({ title, extra, children }: { title?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="dy-card">
      {(title || extra) && (
        <header className="dy-card__header">
          <h2 className="dy-card__title">{title}</h2>
          {extra}
        </header>
      )}
      <div className="dy-card__body">{children}</div>
    </section>
  );
}
