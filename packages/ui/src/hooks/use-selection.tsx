import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

export function useSelection<Id>({ ids }: { ids: readonly Id[] }) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<Id>>(() => new Set());
  const anchor = useRef<{ id: Id; state: boolean } | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppress = useRef(false);
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => () => cancelPress(), [cancelPress]);
  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);
  const exit = useCallback(() => {
    setActive(false);
    clear();
    cancelPress();
  }, [clear, cancelPress]);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && active) exit();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, exit]);
  const enter = useCallback((id?: Id) => {
    setActive(true);
    if (id !== undefined) {
      setSelected((old) => new Set(old).add(id));
      anchor.current = { id, state: true };
    }
  }, []);
  const toggle = useCallback(
    (id: Id, options?: { shift?: boolean }) => {
      setActive(true);
      const next = new Set(selected);
      const from = anchor.current && ids.indexOf(anchor.current.id);
      const to = ids.indexOf(id);
      if (options?.shift && from !== null && from !== -1 && to !== -1 && anchor.current) {
        for (const item of ids.slice(Math.min(from, to), Math.max(from, to) + 1))
          anchor.current.state ? next.add(item) : next.delete(item);
      } else {
        const state = !next.has(id);
        state ? next.add(id) : next.delete(id);
        anchor.current = { id, state };
      }
      setSelected(next);
    },
    [ids, selected],
  );
  const selectAll = useCallback(() => {
    setActive(true);
    setSelected(new Set(ids));
  }, [ids]);
  const bind = useCallback(
    (id: Id) => ({
      onPointerDown: (event: PointerEvent) => {
        suppress.current = false;
        if (event.pointerType !== 'touch') return;
        cancelPress();
        const { clientX: x, clientY: y } = event;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            suppress.current = true;
            enter(id);
          }, 500),
        };
      },
      onPointerMove: (event: PointerEvent) => {
        if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10)
          cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onContextMenu: (event: MouseEvent) => {
        if (suppress.current || press.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onClick: (event: MouseEvent) => {
        if (suppress.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (active || event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          toggle(id, { shift: event.shiftKey });
        }
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (active && (event.key === ' ' || event.key === 'Enter')) {
          event.preventDefault();
          event.stopPropagation();
          toggle(id, { shift: event.shiftKey });
        }
      },
    }),
    [active, cancelPress, enter, toggle],
  );
  return { active, selected, isSelected: (id: Id) => selected.has(id), enter, toggle, selectAll, clear, exit, bind };
}
