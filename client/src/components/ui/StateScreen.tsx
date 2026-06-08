import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./StateScreen.scss";

type StateTone = "neutral" | "danger";

interface StateScreenProps {
  icon?: ReactNode;
  title: string;
  helper?: ReactNode;
  action?: ReactNode;
  tone?: StateTone;
}

export function StateScreen({
  icon,
  title,
  helper,
  action,
  tone = "neutral",
}: StateScreenProps) {
  return (
    <div className="state_screen">
      {icon && (
        <span className={cx("state_screen_icon", `state_screen_icon_${tone}`)}>
          {icon}
        </span>
      )}
      <h1 className="state_screen_title">{title}</h1>
      {helper && <p className="state_screen_helper">{helper}</p>}
      {action && <div className="state_screen_action">{action}</div>}
    </div>
  );
}
