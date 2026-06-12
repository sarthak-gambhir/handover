import type { ReactNode } from "react";
import "./EmptyState.scss";

export function EmptyState({
  icon,
  title,
  helper,
}: {
  icon?: ReactNode;
  title: string;
  helper?: string;
}) {
  return (
    <div className="empty_state">
      {icon && <div className="empty_state_icon">{icon}</div>}
      <p className="empty_state_title">{title}</p>
      {helper && <p className="empty_state_helper">{helper}</p>}
    </div>
  );
}
