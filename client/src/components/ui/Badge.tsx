import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Badge.scss";

type BadgeVariant = "accent" | "neutral" | "warn" | "danger" | "success";

export function Badge({
  variant = "neutral",
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return <span className={cx("badge", `badge_${variant}`)}>{children}</span>;
}
