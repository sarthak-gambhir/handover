import type { MouseEventHandler, ReactNode } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "./BrandMark";
import "./AppBar.scss";

interface AppBarProps {
  // Right-hand contextual slot (session identity, actions, etc.).
  children?: ReactNode;
  // Optional guard for the brand/home link (e.g. confirm before leaving a
  // session). Call preventDefault() to block navigation.
  onBrandClick?: MouseEventHandler<HTMLAnchorElement>;
}

export function AppBar({ children, onBrandClick }: AppBarProps) {
  return (
    <header className="app_bar">
      <div className="app_bar_inner">
        <Link
          className="app_bar_brand"
          to="/"
          aria-label="HandOver home"
          onClick={onBrandClick}
        >
          <BrandMark className="app_bar_mark" size={32} />
          <span className="app_bar_wordmark">HandOver</span>
        </Link>
        {children && <div className="app_bar_slot">{children}</div>}
      </div>
    </header>
  );
}
