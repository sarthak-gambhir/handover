import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Badge } from "./Badge";
import "./Panel.scss";

interface PanelProps {
  title?: ReactNode;
  icon?: ReactNode;
  // Optional count rendered as a badge next to the title.
  count?: number;
  // Secondary line under the title.
  meta?: ReactNode;
  // Right-aligned controls in the header.
  actions?: ReactNode;
  className?: string;
  // Removes body padding (e.g. when the body is a full-bleed list).
  flush?: boolean;
  children: ReactNode;
}

export function Panel({
  title,
  icon,
  count,
  meta,
  actions,
  className,
  flush = false,
  children,
}: PanelProps) {
  const hasHeader = title != null || actions != null;
  return (
    <section className={cx("panel", className)}>
      {hasHeader && (
        <header className="panel_head">
          <div className="panel_head_text">
            {title != null && (
              <h2 className="panel_title">
                {icon && <span className="panel_title_icon">{icon}</span>}
                <span className="panel_title_label">{title}</span>
                {count != null && <Badge variant="neutral">{count}</Badge>}
              </h2>
            )}
            {meta != null && <span className="panel_meta">{meta}</span>}
          </div>
          {actions != null && <div className="panel_actions">{actions}</div>}
        </header>
      )}
      <div className={cx("panel_body", flush && "panel_body_flush")}>
        {children}
      </div>
    </section>
  );
}
