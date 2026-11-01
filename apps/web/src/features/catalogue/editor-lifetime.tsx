import { createContext, isValidElement, useContext, useMemo, type ComponentType } from 'react';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';

const Work = createContext<ReturnType<typeof useCatalogueLifetime> | null>(null);

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
    // Preserve stable transport identities (notably effect dependencies) on a healthy rerender.
    const cache = useMemo(() => new WeakMap<object, unknown>(), [work]);
    const callbacks = useMemo(() => new WeakMap<object, unknown>(), [work]);
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
        Reflect.set(bound, key, fence(value(key), work, cache));
      else if (key.startsWith('on') && typeof value(key) === 'function') {
        const callback = value(key) as (...args: unknown[]) => unknown;
        let guarded = callbacks.get(callback);
        if (!guarded) {
          guarded = (...args: unknown[]) => (work.active() ? callback(...args) : undefined);
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
