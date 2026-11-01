import { createContext, isValidElement, useContext, type ComponentType } from 'react';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';

const Work = createContext<ReturnType<typeof useCatalogueLifetime> | null>(null);

/** Each independent editor owns its address and command; callback identities are not addresses. */
export function catalogueEditor<Props extends object>(Component: ComponentType<Props>) {
  return function CatalogueEditor(props: Props) {
    const value = (key: string) => Reflect.get(props, key);
    const composition = value('composition');
    const work = useCatalogueLifetime(JSON.stringify([
      value('id'), value('work'), value('locale'), value('realm'), value('context'),
      value('address'), value('property'), value('statement'),
      composition?.slot, composition?.statement,
    ]));
    const bound = { ...props };
    for (const key of Object.keys(bound)) {
      if (['transport', 'editors', 'facts', 'relations', 'review', 'confirm', 'propose', 'search', 'refresh'].includes(key))
        Reflect.set(bound, key, fence(value(key), work));
      else if (key.startsWith('on') && typeof value(key) === 'function') {
        const callback = value(key);
        Reflect.set(bound, key, (...args: unknown[]) => work.active() ? callback(...args) : undefined);
      }
    }
    return <Work.Provider value={work}><Component key={work.generation} {...bound} /></Work.Provider>;
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
function fence(value: unknown, work: ReturnType<typeof useCatalogueLifetime>): unknown {
  if (typeof value === 'function') return (...args: unknown[]) => {
    if (!work.active()) throw new Error('Retired catalogue editor');
    const result = value(...args);
    if (result && typeof result.then === 'function') return result.then((next: unknown) => {
      if (!work.active()) throw new Error('Retired catalogue editor');
      return next;
    });
    return fence(result, work);
  };
  if (!value || typeof value !== 'object' || isValidElement(value) || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fence(child, work)]));
}
