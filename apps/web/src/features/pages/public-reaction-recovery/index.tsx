import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Only the public count query is retried; private reaction recovery has its own owner. */
export function PublicReactionRecovery({
  available,
  pending,
  retry,
  labels,
  children,
}: {
  available: boolean;
  pending: boolean;
  retry?: (() => void) | undefined;
  labels: { group: string; pending: string; unavailable: string; retry: string };
  children?: ReactNode;
}) {
  const group = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const intent = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const retire = (event: FocusEvent) => {
      if (event.target !== intent.current) intent.current = null;
    };
    document.addEventListener('focusin', retire);
    return () => {
      intent.current = null;
      document.removeEventListener('focusin', retire);
    };
  }, []);
  useLayoutEffect(() => {
    const source = intent.current;
    if (!source || pending) return;
    intent.current = null;
    if (document.activeElement !== source && document.activeElement !== document.body) return;
    (available ? group.current : button.current)?.focus();
  }, [available, pending]);
  return (
    <div
      ref={group}
      role="group"
      aria-label={labels.group}
      aria-busy={pending}
      tabIndex={-1}
      className="min-w-0 flex-1 sm:flex-none"
    >
      {available ? (
        children
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground" role="status">
            {pending ? labels.pending : labels.unavailable}
          </p>
          {retry && (
            <button
              ref={button}
              type="button"
              className="min-h-11 min-w-11 rounded-md px-2 py-1 text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={pending}
              onClick={(event) => {
                if (pending) return;
                intent.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
                retry();
              }}
            >
              {labels.retry}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
