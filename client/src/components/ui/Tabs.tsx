import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Tabs.scss";

export interface TabItem {
  id: string;
  label: ReactNode;
  // id of the panel this tab controls (for aria-controls).
  panelId?: string;
  // Optional trailing count/badge.
  badge?: ReactNode;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}

export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function focusTab(id: string) {
    onChange(id);
    refs.current[id]?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const idx = items.findIndex((t) => t.id === value);
    if (idx === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusTab(items[(idx + 1) % items.length].id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusTab(items[(idx - 1 + items.length) % items.length].id);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(items[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(items[items.length - 1].id);
    }
  }

  return (
    <div
      className={cx("tabs", className)}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab_${t.id}`}
            aria-selected={selected}
            aria-controls={t.panelId}
            tabIndex={selected ? 0 : -1}
            className={cx("tabs_tab", selected && "tabs_tab_active")}
            onClick={() => onChange(t.id)}
          >
            <span className="tabs_tab_label">{t.label}</span>
            {t.badge != null && <span className="tabs_tab_badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
