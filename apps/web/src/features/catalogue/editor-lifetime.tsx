import {
  createContext,
  isValidElement,
  useContext,
  useMemo,
  useRef,
  useLayoutEffect,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';

const Work = createContext<ReturnType<typeof useCatalogueLifetime> | null>(null);
const CurrentReading = createContext<{ visible: boolean; active: () => boolean } | null>(null);

/** Retain private editor state without rendering a retired public reading. Each observation
 * permanently fences callbacks and requests from the previous reading, including after recovery.
 */
export function CatalogueCurrentReading({
  visible,
  ready,
  revision,
  children,
}: {
  visible: boolean;
  ready: boolean;
  revision: string;
  children: ReactNode;
}) {
  const latest = useRef<object | null>(null);
  const admission = useMemo(() => {
    const token = {};
    return { token, visible, active: () => ready && latest.current === token };
  }, [visible, ready, revision]);
  latest.current = admission.token;
  useLayoutEffect(() => {
    latest.current = admission.token;
    return () => {
      latest.current = null;
    };
  }, [admission]);
  return <CurrentReading.Provider value={admission}>{children}</CurrentReading.Provider>;
}

export function useCurrentReadingActive() {
  return useContext(CurrentReading)?.active ?? (() => true);
}

export function useCurrentReadingVisible() {
  return useContext(CurrentReading)?.visible ?? true;
}

function useReadingLifetime(work: ReturnType<typeof useCatalogueLifetime>) {
  const admission = useContext(CurrentReading);
  return useMemo(
    () => (admission ? { ...work, active: () => work.active() && admission.active() } : work),
    [work, admission],
  );
}

/** Each independent editor owns its address and command; callback identities are not addresses. */
export function catalogueEditor<Props extends object>(Component: ComponentType<Props>) {
  return function CatalogueEditor(props: Props) {
    const value = (key: string): unknown => Reflect.get(props, key);
    const composition = value('composition') as { slot?: unknown; statement?: unknown } | undefined;
    const initial = value('initial') as
      | { public?: { subject?: { id?: string } }; property?: unknown; source?: { id?: string } }
      | undefined;
    const row = value('row') as { id?: string; statement?: { id?: string; property?: { id?: string } } } | undefined;
    const read = value('read') as { public?: { subject?: { id?: string } } } | undefined;
    const ancestor = useContext(Work);
    const work = useCatalogueLifetime(
      JSON.stringify([
        value('id'),
        value('work'),
        value('locale'),
        value('realm'),
        value('context'),
        value('address'),
        value('property'),
        value('statement'),
        composition?.slot,
        composition?.statement,
        initial?.public?.subject?.id,
        initial?.property,
        initial?.source?.id,
        read?.public?.subject?.id,
        row?.id,
        row?.statement?.id,
        row?.statement?.property?.id,
      ]),
      ancestor,
    );
    const reading = useReadingLifetime(work);
    // Preserve the mount's drafts while binding I/O to this current reading only.
    const cache = useMemo(() => new WeakMap<object, unknown>(), [reading]);
    const callbacks = useMemo(() => new WeakMap<object, unknown>(), [reading]);
    const bound = { ...props };
    for (const key of Object.keys(bound)) {
      if (
        [
          'transport',
          'lifecycle',
          'editors',
          'facts',
          'relations',
          'review',
          'confirm',
          'propose',
          'search',
          'refresh',
        ].includes(key)
      )
        Reflect.set(bound, key, fence(value(key), reading, cache));
      else if (key.startsWith('on') && typeof value(key) === 'function') {
        const callback = value(key) as (...args: unknown[]) => unknown;
        let guarded = callbacks.get(callback);
        if (!guarded) {
          guarded = (...args: unknown[]) => (reading.active() ? callback(...args) : undefined);
          callbacks.set(callback, guarded);
        }
        Reflect.set(bound, key, guarded);
      }
    }
    return (
      <Work.Provider value={work}>
        <Component key={work.generation} {...bound} />
      </Work.Provider>
    );
  };
}

export function useEditorLifetime() {
  return useReadingLifetime(useEditorWorkspaceLifetime());
}

/** Holder state survives a retired public reading, but never its caller's retirement. */
export function useEditorWorkspaceLifetime() {
  const work = useContext(Work);
  if (!work) throw new Error('Missing catalogue editor lifetime');
  return work;
}

/** The transport belongs to this mount, including factories for an independent embedded holder.
 * Check both sides of the promise: a retired read must never populate a Query cache.
 */
function fence(
  value: unknown,
  work: ReturnType<typeof useCatalogueLifetime>,
  cache: WeakMap<object, unknown>,
): unknown {
  if ((typeof value === 'function' || (value && typeof value === 'object')) && cache.has(value))
    return cache.get(value);
  if (typeof value === 'function') {
    const guarded = (...args: unknown[]) => {
      if (!work.active()) throw new Error('Retired catalogue editor');
      const result = value(...args);
      if (result && typeof result.then === 'function')
        return result.then((next: unknown) => {
          if (!work.active()) throw new Error('Retired catalogue editor');
          return next;
        });
      return fence(result, work, cache);
    };
    cache.set(value, guarded);
    return guarded;
  }
  if (!value || typeof value !== 'object' || isValidElement(value) || Array.isArray(value)) return value;
  const guarded = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fence(child, work, cache)]));
  cache.set(value, guarded);
  return guarded;
}
