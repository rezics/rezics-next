import type { CompositionDocument } from '@rezics/composition';
import { RoutePage, type RoutePageData } from '../../pages/route';
import { subjectPageMessages } from '../../pages/route-support';
import { ZonePageSurface, ZoneShell, zonePageTitle } from '../../../zones/zone-shell';
import type { ZonePageResponse } from './model';

/** The reader's existing shell and COMMON renderer consume the actual persisted readPage response. */
export default function SavedPreview({
  page,
  route,
  locale,
}: {
  page: ZonePageResponse;
  route: string;
  locale: string;
}) {
  return (
    <ZoneShell zone={page.zone} route={route} locale={locale}>
      <ZonePageSurface zone={page.zone} document={page.document as CompositionDocument}>
        {(document) => (
          <RoutePage
            page={{ ...page, route, document } as unknown as RoutePageData}
            locale={locale}
            heading={zonePageTitle(page.zone, route, locale)}
            messages={subjectPageMessages()}
            renderJsonLd={false}
          />
        )}
      </ZonePageSurface>
    </ZoneShell>
  );
}
