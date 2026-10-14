import { cookies } from 'next/headers';
import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getTranslation } from '../../i18n/server.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { readSession } from '../auth/session.ts';
import { readShowcaseEditor, ZoneEditSiteLink } from './edit-site-link.tsx';

/** The showcase-editor read. A refusal is no link. The Realm frame uses this same check. */
export const showcaseEditorOpen = cache(async (zoneId: string, actingSubject: string, token: string | undefined) =>
  (await readShowcaseEditor(mainApiWithToken(token), zoneId, actingSubject)).loaded);

/**
 * Edit site, for a reader who can already open this Zone's editor.
 * Anyone else, including a signed-out reader, sees nothing and is not sent to sign in.
 */
export async function ZoneEditLink({ zoneId, space, locale, className }: {
  zoneId: string;
  space: string;
  locale: UiLocale;
  className?: string;
}) {
  const session = await readSession();
  if (!session || session.agent.status !== 'selected') return null;
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const allowed = await showcaseEditorOpen(zoneId, session.agent.agent.iri, token);
  if (!allowed.ok) return null;
  const { t } = await getTranslation('manage', [locale]);
  return <ZoneEditSiteLink space={space} className={className}>{t.editSite}</ZoneEditSiteLink>;
}
