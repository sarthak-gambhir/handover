import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { FaCircleCheck, FaTriangleExclamation, FaCircleXmark, FaCircleInfo } from 'react-icons/fa6';
import { cx } from '../../lib/cx';
import { useExitAnimation } from '../../lib/use_exit_animation';
import './Toast.scss';

export type ToastVariant = 'success' | 'warn' | 'danger' | 'info';

interface ToastEntry {
  id: number;
  message: string;
  variant: ToastVariant;
  open: boolean;
}

interface ToastApi {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const ICONS: Record<ToastVariant, ReactNode> = {
  success: <FaCircleCheck size={18} />,
  warn: <FaTriangleExclamation size={18} />,
  danger: <FaCircleXmark size={18} />,
  info: <FaCircleInfo size={18} />,
};

function ToastItem({ entry, onRemove }: { entry: ToastEntry; onRemove: (id: number) => void }) {
  const { mounted, exiting, ref } = useExitAnimation(entry.open, 200);
  if (!mounted) {
    // Defer removal to after exit completes.
    queueMicrotask(() => onRemove(entry.id));
    return null;
  }
  return (
    <div
      ref={ref}
      className={cx('toast', `toast_${entry.variant}`, exiting && 'toast_exiting')}
      role="status"
    >
      <span className="toast_icon">{ICONS[entry.variant]}</span>
      <span className="toast_message">{entry.message}</span>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const close = useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, open: false } : t)));
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant, open: true }]);
      setTimeout(() => close(id), 4000);
    },
    [close],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {createPortal(
        <div className="toast_stack">
          {toasts.map((t) => (
            <ToastItem key={t.id} entry={t} onRemove={remove} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
