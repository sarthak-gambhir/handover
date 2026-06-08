import type { ButtonHTMLAttributes, ReactNode } from "react";
import { RiLoader4Line } from "react-icons/ri";
import { cx } from "../../lib/cx";
import "./Button.scss";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx(
        "button",
        `button_${variant}`,
        `button_${size}`,
        loading && "button_loading",
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <RiLoader4Line className="button_spinner" size={size === "sm" ? 16 : 18} />
      ) : (
        icon && <span className="button_icon">{icon}</span>
      )}
      {children && <span className="button_label">{children}</span>}
    </button>
  );
}
