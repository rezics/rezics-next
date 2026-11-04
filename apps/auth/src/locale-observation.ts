import { createElement, useSyncExternalStore, type ComponentType } from 'react';
import { getLocale, isLocale, overwriteGetLocale, setLocale, type Locale } from './paraglide/runtime.js';
import { storedInterfaceLocale } from './locale-choice';

const listeners = new Set<() => void>();
const observed = new WeakMap<ComponentType, ComponentType>();
let documentLocale: Locale | undefined;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useInterfaceLocale() {
  // On the server getLocale uses Paraglide's request-local AsyncLocalStorage.
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

function publish(locale: Locale) {
  documentLocale = locale;
  document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

/** Client entry only: a blocked cookie must not change the server's hydration choice. */
export function initializeDocumentLocale(initial: string) {
  documentLocale = isLocale(initial) ? initial : getLocale();
  document.documentElement.lang = documentLocale;
  overwriteGetLocale(() => documentLocale!);
}

/** No route invalidation, read refresh, navigation or command is part of presentation. */
export function applyDocumentLocale(value: string): 'saved' | 'temporary' | 'unsupported' {
  if (!isLocale(value)) return 'unsupported';
  if (documentLocale === undefined) initializeDocumentLocale(document.documentElement.lang);
  // These configured strategies are synchronous; reload:false retains the mounted journey.
  // Paraglide owns the cookie name, scope and lifetime. Cookie denial is allowed by its runtime.
  setLocale(value, { reload: false });
  publish(value);
  return storedInterfaceLocale() === value ? 'saved' : 'temporary';
}

/** A BFCache restore can observe a newer choice, but must never write the old cookie back. */
export function restoreDocumentLocale() {
  publish(storedInterfaceLocale() ?? documentLocale ?? getLocale());
}

/**
 * Router MatchInner memoizes its route element. Observe inside that element so a locale
 * publication re-renders the same component type and key without reloading any route.
 * Wrappers contain no request data and can safely be reused by independent SSR routers.
 */
export function observeLocaleComponent(Component: ComponentType): ComponentType {
  const existing = observed.get(Component);
  if (existing) return existing;
  function LocaleObservedRoute() {
    useInterfaceLocale();
    return createElement(Component);
  }
  Object.assign(LocaleObservedRoute, Component);
  observed.set(Component, LocaleObservedRoute);
  observed.set(LocaleObservedRoute, LocaleObservedRoute);
  return LocaleObservedRoute;
}
