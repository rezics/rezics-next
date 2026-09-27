import { cookies, headers } from 'next/headers';
import type { NamespaceOf, NamespaceSource } from 'native-i18n';
import type { UiLocale } from './define.ts';
import { LOCALE_COOKIE, i18n, resolveLocale } from './locale.ts';
import type { resources } from './resources.ts';

export async function requestLocale() {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, requestHeaders.get('accept-language'));
}

/** Materialized strings (`t.title`, `t.count({ count })`) for server code such as metadata. */
export const getTranslation = i18n.getTranslation;

type Namespace = NamespaceOf<typeof resources>;

/**
 * A namespace's serializable catalog, the `messages` prop of feature components.
 * Unlike `getTranslation().data` it keeps recipes as data, so it can cross into
 * Client Components; components materialize it with `materializeData(messages, { locale })`.
 */
export async function getMessages<N extends Namespace>(namespace: N, locale: UiLocale):
  Promise<NamespaceSource<typeof resources, N>> {
  const { snapshot } = await getTranslation(namespace, [locale]);
  const namespaces: Record<string, unknown> = snapshot.namespaces;
  return namespaces[namespace] as NamespaceSource<typeof resources, N>;
}
