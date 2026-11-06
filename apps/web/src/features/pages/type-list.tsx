import { createContext, useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { SectionHeading } from '../../library/section-heading';
import { CoverList } from './cover-list';
import { OverviewContext, type Item } from './overview';
import { pageText, linkClass, linkColor } from './shared';
import { typeListHref, type TypeListTarget } from './type-list-model';
import { nativeTypeListPage } from './type-list-page-admission';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { subjectHref } from '../../subject/subject-href';
import { admittedCatalogueWorkId } from '../feed/home-work-library/contract';
import { HomeWorkLibraryAction, useHomeWorkLibraryEnabled } from '../feed/home-work-library/view';

export const TypeListContext = createContext<{ target?: TypeListTarget; full?: string; cursor?: string }>({});

const controlClass = `${linkClass} ${linkColor} inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-sm px-2 py-2 text-start whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/** Render the native window and its supplied public comparison context without hydrating its targets. */
export function TypeList(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const { target, full, cursor } = useContext(TypeListContext);
  const homeLibraryEnabled = useHomeWorkLibraryEnabled();
  const id = String(props.id);
  const section = value?.sections.get(id);
  const retryWaiting = useSearchRetryWait(section && !section.ok ? section.retryAt : undefined);
  if (!value) return null;
  if (section && !section.ok && section.status === 204) return null;
  const title = pageText(props.title, value.locale);
  const options = { locale: value.locale as never };
  const page = section?.ok ? nativeTypeListPage(section.read, section.body) : undefined;
  const items: Item[] = (page?.subjects ?? []).map((hit) => {
    const label = pageText(hit.labels, value.locale);
    const workId = homeLibraryEnabled ? admittedCatalogueWorkId({ id: hit.id, summary: hit.summary }) : undefined;
    const href = subjectHref({ id: hit.id, label: label.text }, value.locale).href;
    return {
      id: hit.id,
      label,
      notes: [],
      gated: false,
      type: hit.type,
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
  const href = target ? typeListHref(value.locale, target, id, full === id ? cursor : undefined) : undefined;
  const next = page?.next && target ? typeListHref(value.locale, target, id, page.next) : undefined;
  return (
    <section data-slot="type-list" aria-labelledby={`${id}-title`} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
          <ListHeading full={full === id} id={`${id}-title`} lang={title.lang}>
            {title.text}
          </ListHeading>
        </div>
        {full !== id && href && (
          <a data-slot="see-all" href={href} className={controlClass}>
            {m.home_see_all({}, options)}
          </a>
        )}
      </div>
      {!page ? (
        <p role="alert" className="[overflow-wrap:anywhere]">
          {m.subject_section_failed({}, options)}{' '}
          {href &&
            (retryWaiting ? (
              <button
                type="button"
                disabled
                className={`${controlClass} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {m.subject_section_retry({}, options)}
              </button>
            ) : (
              <a href={href} className={controlClass}>
                {m.subject_section_retry({}, options)}
              </a>
            ))}
        </p>
      ) : (
        <>
          {items.length ? (
            <CoverList
              items={items}
              value={value}
              label={title.text}
              preview={full !== id}
              memberCatalogue={Object.fromEntries((page?.subjects ?? []).map((hit) => [hit.id, hit.catalogue]))}
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

function ListHeading({ full, ...props }: import('react').ComponentProps<typeof SectionHeading> & { full: boolean }) {
  return full ? <PageHeading {...props} /> : <SectionHeading {...props} />;
}

export type ZoneDestinations = {
  zoneId: string;
  locale: string;
  route: string;
  cursor?: string;
};

export const ZoneDestinationsContext = createContext<ZoneDestinations | null>(null);

function zoneRouteHref(locale: string, zoneId: string, route = '', cursor?: string, list?: string): string {
  const suffix = route ? `/${route.split('/').map(encodeURIComponent).join('/')}` : '';
  const path = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zoneId)}${suffix}`;
  const params = new URLSearchParams();
  if (list) params.set('list', list);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function zoneSubjectHref(locale: string, zoneId: string, subjectId: string, view?: string): string {
  const base = `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(zoneId)}/subjects/${encodeURIComponent(subjectId)}`;
  return view && view !== 'overview' ? `${base}/${encodeURIComponent(view)}` : base;
}

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
          <ListHeading full={full} id={`${id}-title`} lang={title.lang}>
            {title.text}
          </ListHeading>
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
