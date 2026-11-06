import { useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { SectionHeading } from '../../library/section-heading';
import { CoverList } from './cover-list';
import { OverviewContext, type Item } from './overview';
import { pageText, linkClass, linkColor } from './shared';
import { nativeTypeListPage } from './type-list-page-admission';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { admittedCatalogueWorkId } from '../feed/home-work-library/contract';
import { HomeWorkLibraryAction, useHomeWorkLibraryEnabled } from '../feed/home-work-library/view';
import { ZoneDestinationsContext, zoneRouteHref, zoneSubjectHref } from './zone-destinations';

const controlClass = `${linkClass} ${linkColor} inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-sm px-2 py-2 text-start whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/** Configured TypeLists stay on the Zone route and open exact Zone subject destinations. */
export function ZoneTypeList(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const destinations = useContext(ZoneDestinationsContext);
  const homeLibraryEnabled = useHomeWorkLibraryEnabled();
  const id = String(props.id);
  const section = value?.sections.get(id);
  const retryWaiting = useSearchRetryWait(section && !section.ok ? section.retryAt : undefined);
  if (!value || !destinations) return null;
  if (section && !section.ok && section.status === 204) return null;
  const title = pageText(props.title, value.locale);
  const options = { locale: value.locale as never };
  const page = section?.ok ? nativeTypeListPage(section.read, section.body) : undefined;
  const full = destinations.cursor !== undefined;
  const items: Item[] = (page?.subjects ?? []).map((hit) => {
    const label = pageText(hit.labels, value.locale);
    const workId = homeLibraryEnabled ? admittedCatalogueWorkId({ id: hit.id, summary: hit.summary }) : undefined;
    const href = zoneSubjectHref(destinations.locale, destinations.zoneId, hit.id);
    return {
      id: hit.id,
      label,
      notes: [],
      gated: false,
      type: hit.type,
      href,
      ...(hit.summary !== null ? { summary: hit.summary } : {}),
      ...(workId
        ? {
            supportSlot: (
              <HomeWorkLibraryAction subjectId={workId} href={`${href}?slot=collections`} locale={value.locale} />
            ),
          }
        : {}),
    };
  });
  const listHref = zoneRouteHref(destinations.locale, destinations.zoneId, destinations.route, undefined, id);
  const next =
    page?.next !== null && page?.next !== undefined
      ? zoneRouteHref(destinations.locale, destinations.zoneId, destinations.route, page.next, id)
      : undefined;
  return (
    <section data-slot="type-list" data-zone-type-list className="min-w-0 space-y-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
          {full ? (
            <PageHeading id={`${id}-title`} lang={title.lang}>
              {title.text}
            </PageHeading>
          ) : (
            <SectionHeading id={`${id}-title`} lang={title.lang}>
              {title.text}
            </SectionHeading>
          )}
        </div>
        {!full && next && (
          <a data-slot="see-all" href={listHref} className={controlClass}>
            {m.home_see_all({}, options)}
          </a>
        )}
      </div>
      {!page ? (
        <p role="alert" className="[overflow-wrap:anywhere]">
          {m.subject_section_failed({}, options)}{' '}
          {retryWaiting ? (
            <button
              type="button"
              disabled
              className={`${controlClass} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {m.subject_section_retry({}, options)}
            </button>
          ) : (
            <a href={listHref} className={controlClass}>
              {m.subject_section_retry({}, options)}
            </a>
          )}
        </p>
      ) : (
        <>
          {items.length ? (
            <CoverList
              items={items}
              value={value}
              label={title.text}
              preview={!full}
              memberCatalogue={Object.fromEntries((page.subjects ?? []).map((hit) => [hit.id, hit.catalogue]))}
            />
          ) : (
            <p role="status">{m.search_no_results({}, options)}</p>
          )}
          {next && (
            <a data-slot="next-page" href={next} className={controlClass}>
              {m.library_more({}, options)}
            </a>
          )}
        </>
      )}
    </section>
  );
}
