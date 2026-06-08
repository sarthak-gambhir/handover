import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "./BrandMark";
import "./AppBar.scss";

interface AppBarProps {
  // Right-hand contextual slot (session identity, actions, etc.).
  children?: ReactNode;
}

export function AppBar({ children }: AppBarProps) {
  return (
    <header className="app_bar">
      <div className="app_bar_inner">
        <Link className="app_bar_brand" to="/" aria-label="HandOver home">
          <BrandMark className="app_bar_mark" size={22} />
          <span className="app_bar_wordmark">HandOver</span>
        </Link>
        {children && <div className="app_bar_slot">{children}</div>}
      </div>
    </header>
  );
}
