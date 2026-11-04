import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { pickText } from '@rezics/composition';
import { releaseDateText } from '../release-search-date';
import { subjectHref, type SubjectHrefInput } from '../../subject/subject-href';
import type {
  WorkContext,
  WorkContextSection,
  WorkContextStatement,
  WorkContextTerm,
  WorkContextValue,
} from './schema';

type Presentation = { locale: string; subjectHrefFor?: ((subject: SubjectHrefInput) => string) | undefined };
const control =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-1 py-1 text-start text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
function options(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}
function Term({ term, locale }: { term: WorkContextTerm; locale: string }) {
  const label = pickText(term.labels, locale);
  return (
    <span lang={label.lang ?? undefined} dir="auto" title={term.id}>
      {label.text || term.id}
    </span>
  );
}
function State({
  state,
  locale,
}: {
  state: Exclude<WorkContextSection, { state: 'current' }> | { state: 'absent' };
  locale: string;
}) {
  const o = options(locale);
  const copy =
    state.state === 'absent'
      ? m.search_work_context_absent({}, o)
      : state.state === 'empty'
        ? m.search_work_context_empty({}, o)
        : state.state === 'withheld'
          ? m.search_work_context_withheld({}, o)
          : state.state === 'unsupported'
            ? m.search_work_context_unsupported({}, o)
            : state.reason === 'limit'
              ? m.search_work_context_limit({}, o)
              : state.reason === 'response_limit'
                ? m.search_work_context_response_limit({}, o)
                : m.search_work_context_unavailable({}, o);
  return (
    <span
      data-context-state={state.state}
      {...(state.state === 'unavailable' ? { 'data-context-reason': state.reason } : {})}
    >
      {copy}
    </span>
  );
}
function Value({ value, locale, subjectHrefFor }: { value: WorkContextValue } & Presentation) {
  const o = options(locale);
  if (value.state !== 'value')
    return (
      <span data-value-state={value.state}>
        {value.state === 'somevalue'
          ? m.search_work_context_unknown({}, o)
          : value.state === 'novalue'
            ? m.search_work_context_no_value({}, o)
            : m.search_work_context_unsupported({}, o)}
      </span>
    );
  switch (value.kind) {
    case 'text':
      return <bdi className="whitespace-pre-wrap">{value.text}</bdi>;
    case 'quantity':
      return (
        <bdi className="tabular-nums">
          {value.amount}
          {value.unit ? ` ${value.unit}` : ''}
        </bdi>
      );
    case 'time':
      return (
        <span
          data-slot="work-context-date"
          data-precision={value.day === undefined ? (value.month === undefined ? 'year' : 'month') : 'day'}
        >
          {releaseDateText(value, locale)}
        </span>
      );
    case 'item': {
      const label = pickText(value.labels, locale);
      const target = { id: value.id, label: label.text };
      return (
        <span data-target-id={value.id} data-original-id={value.originalId} data-target-type={value.type.id}>
          <a
            className={control}
            lang={label.lang ?? undefined}
            dir="auto"
            href={subjectHrefFor?.(target) ?? subjectHref(target, locale).href}
          >
            {label.text || m.subject_value_unlabelled({}, o)}
          </a>{' '}
          <span className="text-xs">
            (<Term term={value.type} locale={locale} />)
          </span>
          {value.originalId !== value.id ? (
            <span className="block text-xs">
              {m.search_work_context_original({}, o)} <bdi className="break-all font-mono">{value.originalId}</bdi>
            </span>
          ) : null}
        </span>
      );
    }
  }
}
function Statement({ statement, ...presentation }: { statement: WorkContextStatement } & Presentation) {
  const { locale } = presentation;
  const o = options(locale);
  return (
    <li
      className="min-w-0 space-y-1 border-l-2 border-border pl-2"
      data-statement-id={statement.statementId}
      data-source-id={statement.sourceId}
      data-revision={statement.revision}
      data-release={statement.release}
      data-rank={statement.rank}
      data-direction={statement.direction}
      data-property={statement.property.id}
    >
      <div className="min-w-0">
        <span className="font-medium">
          <Term term={statement.property} locale={locale} />:
        </span>{' '}
        <Value value={statement.value} {...presentation} />
      </div>
      {statement.qualifiers.state === 'current' ? (
        <dl className="ml-2 space-y-1 text-xs" aria-label={m.search_work_context_qualifiers({}, o)}>
          {statement.qualifiers.items.map((qualifier, index) => (
            <div key={index} className="min-w-0" data-qualifier-property={qualifier.property.id}>
              <dt className="inline font-medium">
                <Term term={qualifier.property} locale={locale} />:{' '}
              </dt>
              <dd className="inline">
                <Value value={qualifier.value} {...presentation} />
              </dd>
            </div>
          ))}
        </dl>
      ) : statement.qualifiers.state !== 'empty' ? (
        <p className="ml-2 text-xs">
          {m.search_work_context_qualifiers({}, o)}: <State state={statement.qualifiers} locale={locale} />
        </p>
      ) : null}
      <details className="text-xs">
        <summary className={`${control} cursor-pointer text-muted-foreground`}>
          {m.search_work_context_statement({}, o)}
        </summary>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 break-all pb-2 font-mono">
          <dt>{m.search_work_context_statement({}, o)}</dt>
          <dd>{statement.statementId}</dd>
          <dt>{m.search_work_context_source({}, o)}</dt>
          <dd>{statement.sourceId}</dd>
          <dt>{m.search_work_context_property({}, o)}</dt>
          <dd>{statement.property.id}</dd>
          <dt>{m.search_work_context_direction({}, o)}</dt>
          <dd>{m.search_work_context_outgoing({}, o)}</dd>
          <dt>{m.search_work_context_revision({}, o)}</dt>
          <dd>{statement.revision}</dd>
          <dt>{m.search_work_context_release({}, o)}</dt>
          <dd>{statement.release}</dd>
          <dt>{m.search_work_context_rank({}, o)}</dt>
          <dd>
            {statement.rank === 'preferred'
              ? m.search_work_context_preferred({}, o)
              : m.search_work_context_normal({}, o)}
          </dd>
        </dl>
      </details>
    </li>
  );
}

/** A passive projection inside the existing result row. No reads, context destination or personal authority. */
export function WorkContextView({ context, ...presentation }: { context: WorkContext | undefined } & Presentation) {
  const { locale } = presentation;
  const o = options(locale);
  if (context?.state !== 'current')
    return (
      <div data-slot="search-work-context" className="mt-2 text-sm text-muted-foreground">
        <State state={context ?? { state: 'absent' }} locale={locale} />
      </div>
    );
  const sections = [
    { key: 'creators', label: m.search_work_context_creators({}, o), section: context.creators },
    { key: 'relations', label: m.search_work_context_relations({}, o), section: context.relations },
    { key: 'dates', label: m.search_work_context_dates({}, o), section: context.dates },
  ];
  return (
    <section
      data-slot="search-work-context"
      data-context-kind={context.kind}
      data-context-subject={context.subjectId}
      aria-label={m.search_work_context_heading({}, o)}
      className="mt-2 min-w-0 space-y-2 text-sm text-muted-foreground"
    >
      <p className="font-medium">
        <span>
          {context.kind === 'work'
            ? m.search_work_context_work({}, o)
            : context.kind === 'release'
              ? m.search_work_context_release_kind({}, o)
              : m.search_work_context_recording({}, o)}
        </span>
        {' · '}
        <Term term={context.type} locale={locale} />
      </p>
      <dl className="min-w-0 space-y-2">
        {sections.map(({ key, label, section }) => (
          <div key={key} data-context-category={key}>
            <dt className="font-medium">{label}</dt>
            <dd className="min-w-0">
              {section.state === 'current' ? (
                <>
                  <ul className="mt-1 space-y-2">
                    {section.items.map((statement) => (
                      <Statement key={statement.statementId} statement={statement} {...presentation} />
                    ))}
                  </ul>
                  {section.overflow ? (
                    <p className="mt-1 text-xs" data-context-overflow>
                      {m.search_work_context_overflow({}, o)}
                    </p>
                  ) : null}
                </>
              ) : (
                <State state={section} locale={locale} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
