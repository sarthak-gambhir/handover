import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import "./Popover.scss";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  // The toggle element (the caller wires its onClick to flip `open`).
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  // Accessible label for the popover surface.
  label?: string;
  className?: string;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Popover({
  open,
  onClose,
  trigger,
  children,
  align = "end",
  label,
  className,
}: PopoverProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Move focus into the panel on open.
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    function onDocPointer(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        // Return focus to the trigger for keyboard users.
        wrapRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables =
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className={cx("popover", className)} ref={wrapRef}>
      {trigger}
      {open && (
        <div
          className={cx("popover_panel", `popover_panel_${align}`)}
          role="dialog"
          aria-label={label}
          ref={panelRef}
        >
          {children}
        </div>
      )}
    </div>
  );
}
