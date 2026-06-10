import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { AppBar } from "./AppBar";
import "./Page.scss";

interface PageProps {
  // Contextual content for the right side of the app bar.
  bar?: ReactNode;
  // Widen the content well (used by the Session workspace).
  wide?: boolean;
  // Skip the app bar entirely (e.g. Home, which has its own hero brand).
  hideAppBar?: boolean;
  className?: string;
  children: ReactNode;
}

export function Page({ bar, wide = false, hideAppBar = false, className, children }: PageProps) {
  return (
    <div className="page">
      {!hideAppBar && <AppBar>{bar}</AppBar>}
      <main className={cx("page_main", wide && "page_main_wide", className)}>
        {children}
      </main>
      <footer className="page_footer">
        <span>In-memory transfer. Nothing is stored after the session ends.</span>
      </footer>
    </div>
  );
}
