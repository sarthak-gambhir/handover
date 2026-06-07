import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';
import { useExitAnimation } from '../../lib/use_exit_animation';
import './Modal.scss';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  locked?: boolean; // backdrop + Esc disabled; forces an explicit choice
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, locked = false, children, footer }: ModalProps) {
  const { mounted, exiting, ref } = useExitAnimation(open, 200);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const titleId = `${baseId}_title`;
  const bodyId = `${baseId}_body`;

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    card?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !locked) onClose();
      if (e.key === 'Tab' && card) {
        const focusables = card.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
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
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      lastFocused.current?.focus?.();
    };
  }, [open, locked, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={cx('modal_backdrop', exiting && 'modal_backdrop_exiting')}
      ref={ref}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        className={cx('modal_card', locked && 'modal_card_locked', exiting && 'modal_card_exiting')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={bodyId}
        ref={cardRef}
      >
        {title && <h2 className="modal_title" id={titleId}>{title}</h2>}
        <div className="modal_body" id={bodyId}>{children}</div>
        {footer && <div className="modal_footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
