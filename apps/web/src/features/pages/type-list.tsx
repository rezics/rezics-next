import { createContext, useContext } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { SectionHeading } from '../../library/section-heading';
import { CoverList } from './cover-list';
import { OverviewContext, type Item } from './overview';
import { pageText, linkClass, linkColor } from './shared';
import { typeListHref, type TypeListTarget } from './type-list-model';
import { nativeTypeListPage } from './type-list-page-admission';

export const TypeListContext = createContext<{ target?: TypeListTarget; full?: string }>({});

const controlClass = `${linkClass} ${linkColor} inline-flex min-h-[44px] min-w-[44px] max-w-full items-center rounded-sm px-2 py-2 text-start whitespace-normal [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

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
  const page = section?.ok ? nativeTypeListPage(section.read, section.body) : undefined;
  const items: Item[] = (page?.subjects ?? []).map((hit) => ({
    id: hit.id,
    label: pageText(hit.labels, value.locale),
    notes: [],
    gated: false,
    type: hit.type,
    ...(hit.summary !== null ? { summary: hit.summary } : {}),
  }));
  const href = target ? typeListHref(value.locale, target, id) : undefined;
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
