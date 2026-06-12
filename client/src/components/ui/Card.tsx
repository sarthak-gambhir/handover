import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Card.scss";

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  helper?: ReactNode;
}

export function Card({
  title,
  helper,
  children,
  className,
  ...rest
}: CardProps) {
  return (
    <div className={cx("card", className)} {...rest}>
      {title && <h2 className="card_title">{title}</h2>}
      {helper && <p className="card_helper">{helper}</p>}
      {children}
    </div>
  );
}
