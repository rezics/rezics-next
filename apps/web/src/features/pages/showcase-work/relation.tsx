import { useId, useLayoutEffect, useRef } from 'react';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { CandidateValue } from '../data';
import { CoverList } from '../cover-list';
import type { Item, OverviewValue } from '../overview';
import { isRecord, pageText, spoilerLevel, type Snak } from '../shared';
import { SpoilerGate } from '../values';
import { ValueExplanationEntry } from '../../catalogue/value-explanation-entry';
import type { WorkReturnFocus } from './return';
import { withSubjectVisitReturn } from '../subject-visit-navigation';
import type { PageLink } from '../shared';
import type { DirectedWorkRelation } from './model';

export function kindLabel(kind: DirectedWorkRelation['kind'], locale: string) {
  const o = { locale: locale as never };
  switch (kind) {
    case 'visual-novel':
      return m.work_franchise_kind_visual_novel({}, o);
    case 'game':
      return m.work_franchise_kind_game({}, o);
    case 'screen':
      return m.work_franchise_kind_screen({}, o);
    case 'book':
      return m.work_franchise_kind_book({}, o);
  }
}

const action =
  'inline-flex min-h-11 min-w-11 max-w-full items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Work assertions use ordinary cards and values, never the qualified-credit inspector. */
export function WorkRelation({
  relation,
  item,
  value,
  label,
  returnHref,
  connectionsHref,
  returnToFor,
  restoreFocus,
}: {
  relation: DirectedWorkRelation;
  item: Item;
  value: OverviewValue;
  label: string;
  returnHref?: string;
  connectionsHref?: string;
  returnToFor?: ((focus: 'browse' | 'evidence') => string) | undefined;
  restoreFocus?: WorkReturnFocus | undefined;
}) {
  const heading = useId();
  const explanation = useRef<HTMLDetailsElement>(null);
  const browse = useRef<HTMLDivElement>(null);
  const evidence = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!restoreFocus?.current()) return;
    const target =
      restoreFocus.control === 'evidence' ? evidence.current : browse.current?.querySelector<HTMLElement>('a');
    if (!target) return;
    target.focus({ preventScroll: true });
    restoreFocus.complete();
  }, [restoreFocus]);
  const o = { locale: value.locale as never };
  const holderLabel = relation.direction === 'in' ? relation.label : (value.subjectLabel ?? value.unlabelled);
  const holderHref = subjectHref({ id: relation.holder, label: holderLabel }, value.locale).href;
  const BaseLink = value.link;
  const evidenceReturn = returnToFor?.('evidence') ?? returnHref;
  const Link: PageLink = (props) => (
    <BaseLink
      {...props}
      href={evidenceReturn ? withSubjectVisitReturn(props.href, evidenceReturn, value.locale) : props.href}
    />
  );
  const metadata: unknown = Reflect.get(relation.statement, 'rezics');
  const related = {
    ...relation.related,
    ...(relation.direction === 'in' && value.subject
      ? {
          [value.subject]: { labels: { [value.locale]: value.subjectLabel ?? value.unlabelled } },
        }
      : {}),
  };
  const propertyLabel = (property: string) => {
    const released = value.candidatePropertyLabel?.(property);
    return (
      (released && released !== value.unlabelled ? released : '') ||
      pageText(related[property]?.labels, value.locale).text ||
      value.unlabelled
    );
  };
  const part = (snak: Snak, index: number) => (
    <div key={index} className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{propertyLabel(snak.property.id)}</dt>
      <dd>
        <CandidateValue snak={snak} related={related} locale={value.locale} subject={relation.holder} link={Link} />
      </dd>
    </div>
  );
  const content = (
    <div
      className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      data-original-holder={relation.holder}
      data-work-statement={relation.statement.id}
      data-work-holder={relation.holder}
    >
      <p className="text-sm text-muted-foreground">
        {label} · {relation.direction === 'in' ? m.subject_connections_in({}, o) : m.subject_connections_out({}, o)}
      </p>
      <p className="text-sm text-muted-foreground">{kindLabel(relation.kind, value.locale)}</p>
      <div ref={browse} data-work-action="browse">
        <CoverList
          items={[
            {
              ...item,
              label: pageText(related[relation.id]?.labels, value.locale).text
                ? pageText(related[relation.id]?.labels, value.locale)
                : item.label,
              qualified: [],
              gated: false,
            },
          ]}
          value={value}
          label={label}
        />
      </div>
      {relation.statement.qualifiers.length > 0 && (
        <section className="space-y-2" aria-label={m.value_qualifiers({}, o)}>
          <h5 className="font-medium">{m.value_qualifiers({}, o)}</h5>
          <dl className="space-y-3">{relation.statement.qualifiers.map(part)}</dl>
        </section>
      )}
      <details
        ref={explanation}
        className="min-w-0 space-y-3 rounded-lg border border-border p-3"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !explanation.current?.open) return;
          event.preventDefault();
          event.stopPropagation();
          explanation.current.open = false;
          explanation.current.querySelector('summary')?.focus();
        }}
      >
        <summary ref={evidence} data-work-action="evidence" className={`${action} cursor-pointer`}>
          {m.value_why({}, o)}
        </summary>
        <h4 id={heading} className="font-semibold">
          {label}
        </h4>
        <p>
          <Link href={holderHref} className={action}>
            {holderLabel}
          </Link>
        </p>
        <CandidateValue
          snak={relation.statement}
          related={related}
          locale={value.locale}
          subject={relation.holder}
          link={Link}
        />
        {isRecord(metadata) && typeof metadata.release === 'string' && typeof metadata.revision === 'number' && (
          <dl className="space-y-2 text-sm">
            <div>
              <dt>{m.value_proposal_revision({}, o)}</dt>
              <dd>{metadata.revision}</dd>
            </div>
            <div>
              <dt>{m.value_proposal_release({}, o)}</dt>
              <dd>{metadata.release}</dd>
            </div>
          </dl>
        )}
        <section className="space-y-2" aria-label={m.sources_citations({}, o)}>
          <h5 className="font-medium">{m.sources_citations({}, o)}</h5>
          {relation.statement.references.length ? (
            <ol className="list-decimal space-y-3 ps-5">
              {relation.statement.references.map((reference, index) => (
                <li key={index}>
                  {reference.parts.length ? (
                    <dl className="space-y-2">{reference.parts.map(part)}</dl>
                  ) : (
                    m.value_reference_unavailable({}, o)
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>{m.work_relation_citations_undisclosed({}, o)}</p>
          )}
          <p className="text-sm text-muted-foreground">{m.value_citation_scope({}, o)}</p>
        </section>
        <details>
          <summary className={action}>{m.catalogue_technical_details({}, o)}</summary>
          <p>
            <code>{relation.property}</code> · <code>{relation.statement.id}</code>
          </p>
        </details>
        <nav className="flex min-w-0 flex-wrap gap-3" aria-labelledby={heading}>
          <Link href={`${holderHref}/details`} className={action}>
            {m.subject_details({}, o)}
          </Link>
          <Link href={`${holderHref}/sources`} className={action}>
            {m.subject_sources({}, o)}
          </Link>
          <ValueExplanationEntry
            link={Link}
            {...(evidenceReturn ? { returnTo: evidenceReturn } : {})}
            id={relation.holder}
            title={holderLabel}
            property={relation.property}
            statement={relation.statement.id}
            locale={value.locale}
            {...(value.context ? { context: value.context.id } : {})}
          />
          {connectionsHref && (
            <Link href={connectionsHref} className={action}>
              {m.subject_connections_title({}, o)}
            </Link>
          )}
        </nav>
      </details>
    </div>
  );
  return spoilerLevel(relation.statement) > value.reader.spoilerLevel ? (
    <SpoilerGate label={value.spoilerShow} hideLabel={value.labels.spoilerHide}>
      {content}
    </SpoilerGate>
  ) : (
    content
  );
}
