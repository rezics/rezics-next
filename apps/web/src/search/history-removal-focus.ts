import { useLayoutEffect, useRef } from 'react';

type HistoryEntry = { id: string };
type Removal = {
  kind: 'remove';
  id: string;
  next: string | null;
  previous: string | null;
  source: HTMLButtonElement;
  message: string;
};
type Clear = { kind: 'clear'; ids: string[]; source: HTMLButtonElement; message: string };

function action(list: HTMLUListElement | null, id: string | null): HTMLButtonElement | null {
  if (!list || !id) return null;
  return (
    Array.from(list.querySelectorAll<HTMLButtonElement>('[data-history-action]')).find(
      (button) => button.dataset.historyId === id,
    ) ?? null
  );
}

export function useHistoryRemovalFocus(
  entries: readonly HistoryEntry[],
  visible: readonly HistoryEntry[],
  onComplete: (message: string) => void,
) {
  const regionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const pending = useRef<Removal | Clear | null>(null);

  useLayoutEffect(() => {
    const request = pending.current;
    if (!request) return;
    const remaining = new Set(entries.map(({ id }) => id));
    const completed = request.kind === 'remove' ? !remaining.has(request.id) : request.ids.every((id) => !remaining.has(id));
    if (!completed) return;
    pending.current = null;

    const active = document.activeElement;
    if (active === request.source || active === document.body || active === document.documentElement) {
      const target =
        request.kind === 'clear'
          ? regionRef.current
          : action(listRef.current, request.next) ?? action(listRef.current, request.previous) ?? regionRef.current;
      target?.focus();
    }
    onComplete(request.message);
  }, [entries, onComplete]);

  return {
    regionRef,
    listRef,
    requestRemove(id: string, index: number, source: HTMLButtonElement, message: string) {
      pending.current = {
        kind: 'remove',
        id,
        next: visible[index + 1]?.id ?? null,
        previous: visible[index - 1]?.id ?? null,
        source,
        message,
      };
    },
    requestClear(source: HTMLButtonElement, message: string) {
      pending.current = { kind: 'clear', ids: entries.map(({ id }) => id), source, message };
    },
  };
}
