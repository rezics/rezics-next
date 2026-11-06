import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

type StoreSubscribe = (onStoreChange: () => void) => () => void;
type SelectorMemo<Selection> = { hasValue: boolean; value: Selection };

/** ESM Worker adapter for TanStack Store's React selector hook. */
export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: StoreSubscribe,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (left: Selection, right: Selection) => boolean,
): Selection {
  const instanceRef = useRef<SelectorMemo<Selection>>({ hasValue: false, value: undefined as Selection });
  const instance = instanceRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot = undefined as Snapshot;
    let memoizedSelection = undefined as Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual && instance.hasValue && isEqual(instance.value, nextSelection))
          return (memoizedSelection = instance.value);
        return (memoizedSelection = nextSelection);
      }

      if (Object.is(memoizedSnapshot, nextSnapshot)) return memoizedSelection;
      const nextSelection = selector(nextSnapshot);
      if (isEqual && isEqual(memoizedSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return memoizedSelection;
      }
      memoizedSnapshot = nextSnapshot;
      return (memoizedSelection = nextSelection);
    };

    return [
      () => memoizedSelector(getSnapshot()),
      getServerSnapshot ? () => memoizedSelector(getServerSnapshot()) : undefined,
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    instance.hasValue = true;
    instance.value = value;
  }, [instance, value]);
  useDebugValue(value);
  return value;
}
