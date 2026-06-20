import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import "./Tooltip.scss";

type Placement = "top" | "bottom" | "left" | "right";

interface Coords {
  top: number;
  left: number;
}

interface TooltipProps {
  // The hint text to show. When falsy, the tooltip is disabled entirely.
  label: string | undefined | false;
  placement?: Placement;
  // Only arm the tooltip when the trigger's text is actually clipped
  // (scrollWidth > clientWidth). Used for filename-truncation reveals.
  whenOverflowing?: boolean;
  // A single element (button, span, custom Button, ...) that the tooltip
  // annotates. It must forward pointer/focus handlers to a real DOM node,
  // which the design-system components already do via {...rest}.
  children: ReactElement;
}

const SHOW_DELAY = 300;
const GAP = 8;

function coordsFor(rect: DOMRect, placement: Placement): Coords {
  switch (placement) {
    case "bottom":
      return { top: rect.bottom + GAP, left: rect.left + rect.width / 2 };
    case "left":
      return { top: rect.top + rect.height / 2, left: rect.left - GAP };
    case "right":
      return { top: rect.top + rect.height / 2, left: rect.right + GAP };
    case "top":
    default:
      return { top: rect.top - GAP, left: rect.left + rect.width / 2 };
  }
}

export function Tooltip({
  label,
  placement = "top",
  whenOverflowing = false,
  children,
}: TooltipProps) {
  const id = useId();
  // The live DOM node of the trigger, captured from event.currentTarget so we
  // don't depend on the child forwarding a ref.
  const elRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);

  const disabled = !label;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (whenOverflowing && el.scrollWidth <= el.clientWidth) return;
    setCoords(coordsFor(el.getBoundingClientRect(), placement));
  }, [placement, whenOverflowing]);

  const hide = useCallback(() => {
    clearTimer();
    setCoords(null);
  }, [clearTimer]);

  // Fixed coordinates can't track the trigger, so dismiss on scroll/resize.
  useEffect(() => {
    if (!coords) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") hide();
    }
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onKey);
    };
  }, [coords, hide]);

  useEffect(() => clearTimer, [clearTimer]);

  if (disabled || !isValidElement(children)) return children;

  const childProps = children.props as Record<string, unknown> & {
    onPointerEnter?: (e: PointerEvent) => void;
    onPointerLeave?: (e: PointerEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
    "aria-describedby"?: string;
  };

  const trigger = cloneElement(children, {
    "aria-describedby": cx(childProps["aria-describedby"], id) || undefined,
    onPointerEnter: (e: PointerEvent) => {
      childProps.onPointerEnter?.(e);
      elRef.current = e.currentTarget as HTMLElement;
      clearTimer();
      timerRef.current = setTimeout(show, SHOW_DELAY);
    },
    onPointerLeave: (e: PointerEvent) => {
      childProps.onPointerLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      childProps.onFocus?.(e);
      elRef.current = e.currentTarget as HTMLElement;
      show();
    },
    onBlur: (e: FocusEvent) => {
      childProps.onBlur?.(e);
      hide();
    },
  } as Record<string, unknown>);

  return (
    <>
      {trigger}
      {coords &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className={cx("tooltip", `tooltip_${placement}`)}
            style={{ top: coords.top, left: coords.left }}
          >
            <span className="tooltip_bubble">{label}</span>
          </div>,
          document.body
        )}
    </>
  );
}
