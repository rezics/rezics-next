import { createContext, useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { SectionHeading } from '../../library/section-heading';
import { CoverList } from './cover-list';
import { OverviewContext, type Item } from './overview';
import { isRecord, pageText, linkClass, linkColor } from './shared';
import { typeListHref, type TypeListTarget } from './type-list-model';
import type { SubjectSummary } from '../../media/summary';

export const TypeListContext = createContext<{ target?: TypeListTarget; full?: string }>({});

const controlClass = `${linkClass} ${linkColor} inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-sm px-2 py-2 text-start whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NativeTypeListPage = {
  subjects: { id: string; type: string; labels: Record<string, string>; summary: SubjectSummary }[];
  next: string | null;
};

function nativeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nativeLabels(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((label) => typeof label === 'string');
}

function nativeCover(value: unknown): value is NonNullable<Exclude<SubjectSummary, null>['cover']> {
  if (
    !isRecord(value) ||
    !nativeId(value.media) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    !isRecord(value.placeholder) ||
    typeof value.placeholder.thumbhash !== 'string' ||
    typeof value.placeholder.color !== 'string' ||
    !Array.isArray(value.variants) ||
    !value.variants.every(
      (variant) =>
        isRecord(variant) &&
        (variant.format === 'avif' || variant.format === 'webp') &&
        positiveInteger(variant.width),
    ) ||
    !(
      value.focalPoint === null ||
      (isRecord(value.focalPoint) &&
        typeof value.focalPoint.x === 'number' &&
        Number.isFinite(value.focalPoint.x) &&
        typeof value.focalPoint.y === 'number' &&
        Number.isFinite(value.focalPoint.y))
    ) ||
    !isRecord(value.credit) ||
    typeof value.credit.rightsHolder !== 'string' ||
    !isRecord(value.credit.via) ||
    typeof value.credit.via.name !== 'string' ||
    typeof value.credit.via.url !== 'string' ||
    typeof value.credit.license !== 'string' ||
    !Array.isArray(value.credit.obligations) ||
    !value.credit.obligations.every((obligation) => typeof obligation === 'string')
  )
    return false;
  return true;
}

function nativeSummary(value: unknown, id: string, type: string): value is Exclude<SubjectSummary, null> {
  return (
    isRecord(value) &&
    nativeId(value.id) &&
    value.id.toLowerCase() === id.toLowerCase() &&
    nativeType(value.type) &&
    value.type === type &&
    Array.isArray(value.types) &&
    value.types.every(nativeType) &&
    value.types.includes(type) &&
    (value.label === null ||
      (isRecord(value.label) &&
        typeof value.label.value === 'string' &&
        typeof value.label.language === 'string')) &&
    typeof value.creativeWork === 'boolean' &&
    (value.cover === null || nativeCover(value.cover))
  );
}

function nativeTypeListPage(value: unknown): NativeTypeListPage | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.subjects) ||
    !(value.next === null || (typeof value.next === 'string' && value.next.trim().length > 0))
  )
    return undefined;

  const seen = new Set<string>();
  const subjects: NativeTypeListPage['subjects'] = [];
  for (const row of value.subjects) {
    if (
      !isRecord(row) ||
      !nativeId(row.id) ||
      seen.has(row.id.toLowerCase()) ||
      !nativeType(row.type) ||
      !nativeLabels(row.labels) ||
      !Object.hasOwn(row, 'summary') ||
      !(row.summary === null || nativeSummary(row.summary, row.id, row.type))
    )
      return undefined;
    seen.add(row.id.toLowerCase());
    subjects.push({ id: row.id, type: row.type, labels: row.labels, summary: row.summary });
  }
  return { subjects, next: value.next };
}

/** Render only native search hits and its explicit terminal/continuation outcome, never a detail object's facts. */
export function TypeList(props: Record<string, unknown>) {
  const value = useContext(OverviewContext);
  const { target, full } = useContext(TypeListContext);
  if (!value) return null;
  const id = String(props.id);
  const section = value.sections.get(id);
  if (section && !section.ok && section.status === 204) return null;
  const title = pageText(props.title, value.locale);
  const options = { locale: value.locale as never };
  const page = section?.ok ? nativeTypeListPage(section.body) : undefined;
  const items: Item[] = (page?.subjects ?? []).map((hit) => ({
    id: hit.id,
    label: pageText(hit.labels, value.locale),
    notes: [],
    gated: false,
    type: hit.type,
    ...(hit.summary !== null ? { summary: hit.summary } : {}),
  }));
  const href = target ? typeListHref(value.locale, target, id) : undefined;
  const next =
    page?.next && target ? typeListHref(value.locale, target, id, page.next) : undefined;
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
          {href && (
            <a href={href} className={controlClass}>
              {m.subject_section_retry({}, options)}
            </a>
          )}
        </p>
      ) : (
        <>
          {items.length ? (
            <CoverList items={items} value={value} label={title.text} preview={full !== id} />
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
