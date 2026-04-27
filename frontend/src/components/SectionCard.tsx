import type { PropsWithChildren, ReactNode } from "react";

interface SectionCardProps extends PropsWithChildren {
  title: string;
  actions?: ReactNode;
}

export function SectionCard({ title, actions, children }: SectionCardProps) {
  return (
    <section className="section-card">
      <div className="section-card__header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2>{title}</h2>
        </div>
        {actions ? <div className="section-card__actions">{actions}</div> : null}
      </div>
      <div className="section-card__body">{children}</div>
    </section>
  );
}

