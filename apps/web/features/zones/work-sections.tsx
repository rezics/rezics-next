import type { UiLocale } from '../../i18n/define.ts';
import { cookies } from 'next/headers';
import { getMessages } from '../../i18n/server.ts';
import { readModExact, readModReleases } from '../realm/read.ts';
import { MOD_ENV_COOKIE, readModPreference } from './browse-state.ts';
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
  const saved = readModPreference((await cookies()).get(MOD_ENV_COOKIE)?.value);
  const gameVersion = saved.modGameVersion?.length === 1 ? saved.modGameVersion[0] : null;
  const loader = saved.modLoader?.length === 1 ? saved.modLoader[0] as 'Fabric' | 'Forge' | 'NeoForge' : null;
  const side = saved.modEnvironment?.length === 1 ? saved.modEnvironment[0] as 'client' | 'server' : null;
  const [page, messages, exact] = await Promise.all([readModReleases(work), getMessages('zones', locale),
    gameVersion && loader && side ? readModExact(work, gameVersion, loader, side) : Promise.resolve(null)]);
  return <ModSections releases={page.ok ? page.data.items : []} failed={!page.ok && page.failure !== 'missing'}
    exact={exact?.ok ? exact.data : null} exactFailed={exact !== null && !exact.ok}
    moreReleases={page.ok && page.data.nextCursor !== null}
    selection={gameVersion && loader && side ? { gameVersion, loader, side } : null}
    locale={locale} messages={messages} />;
}
