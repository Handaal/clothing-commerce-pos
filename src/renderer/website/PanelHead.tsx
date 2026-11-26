import type { ReactNode } from "react";

/**
 * Shared header for every Website Management card: the title (with an optional count badge) and a
 * one-line explanation stacked on the left, the card's actions on the right. Keeping the explanation
 * inside the header gives each card one clear top band instead of loose text between the header and
 * the content.
 */
export function PanelHead({
  title,
  count,
  intro,
  children,
}: {
  title: ReactNode;
  count?: number | null;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="staff-card__head website-panel-head">
      <div className="website-panel-head__text">
        <h2>
          {title}
          {count !== undefined && count !== null ? (
            <span className="website-count">{count}</span>
          ) : null}
        </h2>
        {intro ? <p className="website-panel-head__intro">{intro}</p> : null}
      </div>
      {children ? <div className="website-panel-head__actions">{children}</div> : null}
    </div>
  );
}
