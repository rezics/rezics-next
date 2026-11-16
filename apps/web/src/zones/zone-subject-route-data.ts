import type { View } from '@rezics/composition';
import { metaText } from '@rezics/ui/meta-line';
import { subjectPageTitle } from '../features/pages/subject-page-summary';
import { viewTabLabels } from '../features/pages/route-support';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';
import type { ReadCredentialMode } from '../session/reader';
import type { PagePaths } from '../shell/head';
import { subjectHref, subjectViewPaths } from '../subject/subject-href';
import { readZonePageRequest, type ZonePageInput, type ZonePageRouteOutcome } from './zone-read';

export type ZoneSubjectRouteData = { outcome: ZonePageRouteOutcome; paths: PagePaths; view: View };

export async function readZoneSubjectRoute(input: {
  id: string;
  subjectId: string;
  locale?: string;
  credentialMode?: ReadCredentialMode;
  view?: View;
}) {
  const locale = input.locale ?? getLocale();
  const target: ZonePageInput['target'] = {
    subject: input.subjectId,
    ...(input.view && input.view !== 'overview' ? { view: input.view } : {}),
  };
  const outcome = await readZonePageRequest({
    data: {
      id: input.id,
      locale,
      target,
      ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
    },
  });
  const view = input.view ?? 'overview';
  const admittedSubjectId = outcome.kind === 'page' ? (outcome.page.subject ?? input.subjectId) : input.subjectId;
  const overview = outcome.kind === 'page' ? outcome.common?.overview : undefined;
  const basePaths = Object.fromEntries(
    locales.map((language) => {
      const path = overview
        ? subjectHref({ id: admittedSubjectId, label: subjectPageTitle(overview, language) }, language).href
        : `/${encodeURIComponent(language)}/subjects/${encodeURIComponent(admittedSubjectId)}`;
      return [language, path.slice(`/${encodeURIComponent(language)}`.length)];
    }),
  ) as PagePaths;
  return { outcome, paths: subjectViewPaths(basePaths, view), view };
}

export function zoneSubjectHead(data: ZoneSubjectRouteData | undefined, view: View = data?.view ?? 'overview') {
  const locale = getLocale();
  const page = data?.outcome.kind === 'page' ? data.outcome.common?.overview : undefined;
  const title = page ? subjectPageTitle(page, locale) : m.not_found_heading();
  const label = view === 'overview' ? '' : viewTabLabels().names[view];
  return { meta: [{ title: metaText([title, label]) }] };
}
