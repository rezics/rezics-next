import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { readModReleases } from '../realm/read.ts';
import { ModSections } from './mod-sections.tsx';

const MOD_PACKAGE = 'https://rezics.com/vocab/ModPackage';

/**
 * A Work's sections for its type: a mod's releases today. Rendered on the
 * Work page after its description; other types have none yet.
 */
export async function WorkTypeSections({ work, types, locale }: {
  /** The Work's UUID. */
  work: string; types: readonly string[]; locale: UiLocale;
}) {
  if (!types.includes(MOD_PACKAGE)) return null;
  const [page, messages] = await Promise.all([readModReleases(work), getMessages('zones', locale)]);
  return <ModSections releases={page.ok ? page.data.items : []} failed={!page.ok && page.failure !== 'missing'}
    locale={locale} messages={messages} />;
}
