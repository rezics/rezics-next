import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { shortId } from './route.ts';
import type { ScopeRealm, ScopeView } from './scope-bar.tsx';

/** Shared by server-rendered sections and the client scope picker. */
export function realmLabel(realm: ScopeRealm, messages: WorkPageMessages, locale: UiLocale): string {
  return realm.name?.value ?? materializeData(messages, { locale }).realmFallback({ id: shortId(realm.id) });
}

/** The population in headings and empty states, retaining its content language's name. */
export function scopeName(view: ScopeView, messages: WorkPageMessages, locale: UiLocale): string {
  const { scope } = view;
  if (scope.kind !== 'realm') return scope.kind === 'global' ? messages.global : messages.mine;
  return realmLabel(view.realms.find(realm => realm.id === scope.realm) ?? { id: scope.realm, name: null },
    messages, locale);
}
