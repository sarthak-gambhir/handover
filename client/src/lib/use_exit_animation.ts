import { useEffect, useRef, useState } from 'react';

/**
 * Keeps a component mounted through its exit transition.
 *
 * Parent passes `isOpen`. While open, `mounted` is true and `exiting` is false.
 * When `isOpen` flips to false, we keep `mounted` true and set `exiting` true so
 * the caller can apply a `*_exiting` class; once the element's `transitionend`
 * fires (or a fallback timeout elapses) we unmount.
 */
export function useExitAnimation(
  isOpen: boolean,
  durationMs = 200,
): {
  mounted: boolean;
  exiting: boolean;
  ref: React.RefObject<HTMLDivElement>;
} {
  const [mounted, setMounted] = useState(isOpen);
  const [exiting, setExiting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;

    setExiting(true);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setExiting(false);
      setMounted(false);
    };
    const node = ref.current;
    const onEnd = (e: TransitionEvent) => {
      if (e.target === node) finish();
    };
    node?.addEventListener('transitionend', onEnd);
    const t = setTimeout(finish, durationMs + 60);
    return () => {
      node?.removeEventListener('transitionend', onEnd);
      clearTimeout(t);
    };
  }, [isOpen, mounted, durationMs]);

  return { mounted, exiting, ref };
}
