import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { candidateSession, useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { CandidateValue } from '../pages/data';
import { pageText } from '../pages/shared';
import { identifierInspectionHref, type IdentifierInspection } from './identifier-current-visit';
import {
  identifierOccurrence,
  survivingIdentifierOccurrence,
  type IdentifierEvidence,
  type IdentifierEvidenceTransport,
} from './identifier-current-visit-evidence';
import { identifierReturnFocus } from './identifier-current-visit-focus';
import { m } from '../../paraglide/messages.js';
import type { IdentifierVisitOrigin } from './identifier-current-visit';
import { ViewHeading } from '../pages/view-heading';

export function IdentifierOriginChoice({
  locale,
  origin,
  originHref,
  globalHref,
  onChooseGlobal,
}: {
  locale: string;
  origin: IdentifierVisitOrigin;
  originHref?: string | undefined;
  globalHref?: string | undefined;
  onChooseGlobal: () => void;
}) {
  const o = { locale: locale as never };
  const originMessage =
    origin.kind === 'unsupported'
      ? m.identifiers_origin_unsupported({}, o)
      : origin.state === 'changed'
        ? m.identifiers_origin_changed({}, o)
        : origin.state === 'missing'
          ? m.identifiers_origin_missing({}, o)
          : origin.state === 'refused'
            ? m.identifiers_origin_refused({}, o)
            : origin.state === 'unavailable'
              ? m.identifiers_origin_unavailable({}, o)
              : origin.realmTitle
                ? m.identifiers_origin_realm_named({ name: origin.realmTitle }, o)
                : m.identifiers_origin_realm({}, o);
  return (
    <section className="flex flex-col gap-4 p-6" data-slot="identifier-origin-choice">
      <ViewHeading label={m.identifiers_title({}, o)} headingClassName="font-sans" />
      <p role="status">{originMessage}</p>
      <p>{m.identifiers_global_only_notice({}, o)}</p>
      {originHref ? (
        <a className="min-h-11 underline underline-offset-4" href={originHref}>
          {m.identifiers_return_origin({}, o)}
        </a>
      ) : globalHref ? (
        <a className="min-h-11 underline underline-offset-4" href={globalHref}>
          {m.identifiers_open_global_subject({}, o)}
        </a>
      ) : null}
      <button type="button" className="min-h-11 self-start underline underline-offset-4" onClick={onChooseGlobal}>
        {m.identifiers_global_choice({}, o)}
      </button>
    </section>
  );
}

const visitControl =
  'inline-flex min-h-11 min-w-11 max-w-full items-center underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring';
let nextSource = 0;

export type IdentifierCurrentVisitProps = {
  id: string;
  locale: string;
  origin?: IdentifierVisitOrigin | undefined;
  initialInspection?: IdentifierInspection | undefined;
  initialReview?: { property: string; candidate: string } | undefined;
  editorHref: string;
  transport: IdentifierEvidenceTransport;
};

/** This public reader and the Global correction workspace never share a response or source assertion. */
export const IdentifierCurrentVisit = candidateSession(IdentifierVisitBoundary);

function IdentifierVisitBoundary(props: IdentifierCurrentVisitProps) {
  const source = useMemo(() => ++nextSource, [props.transport]);
  const lifetime = useCatalogueLifetime(
    JSON.stringify([props.id, props.locale, props.origin, props.initialReview, props.initialInspection, source]),
  );
  return <IdentifierVisitReader key={lifetime.generation} {...props} lifetime={lifetime} />;
}

function IdentifierVisitReader({
  id,
  locale,
  origin,
  initialInspection,
  editorHref,
  transport,
  lifetime,
}: IdentifierCurrentVisitProps & { lifetime: ReturnType<typeof useCatalogueLifetime> }) {
  const o = { locale: locale as never };
  const [opened, setOpened] = useState(!!initialInspection);
  const [inspection, setInspection] = useState(initialInspection);
  const region = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const targets = useRef(new Map<string, HTMLButtonElement>());
  const focusLease = useRef<ReturnType<typeof identifierReturnFocus> | undefined>(undefined);
  const pending = useRef<
    | {
        focus: ReturnType<typeof identifierReturnFocus>;
        previous: IdentifierEvidence;
        address: IdentifierInspection;
      }
    | undefined
  >(undefined);
  const query = useQuery({
    queryKey: ['identifier-public-origin', id, locale, lifetime.generation],
    queryFn: async () => {
      const result = await transport.read();
      if (!lifetime.active()) throw new Error('Retired Identifier public reading');
      return result;
    },
    enabled: opened && origin?.kind !== 'unsupported',
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const result = query.isFetching || query.isError ? undefined : query.data;
  const evidence = result?.kind === 'ready' ? result.evidence : undefined;
  const statement = evidence && inspection ? identifierOccurrence(evidence, inspection) : undefined;
  useLayoutEffect(() => () => focusLease.current?.cancel(), []);
  useLayoutEffect(() => {
    const returning = pending.current;
    if (!returning || query.isFetching) return;
    pending.current = undefined;
    const key = `${returning.address.property}:${returning.address.statement}`;
    const exact = evidence && survivingIdentifierOccurrence(returning.previous, evidence, returning.address);
    const target = (exact && targets.current.get(key)) || heading.current;
    if (target) returning.focus.settle(target);
  }, [query.isFetching, evidence, query.isError]);
  if (origin?.kind === 'unsupported') return null;
  return (
    <section
      ref={region}
      data-slot="identifier-current-visit"
      className="min-w-0 space-y-4 p-6 [overflow-wrap:anywhere]"
    >
      <ViewHeading
        label={m.identifiers_public_heading({}, o)}
        headingClassName="font-sans"
        headingRef={heading}
        headingTabIndex={-1}
      />
      {!opened ? (
        <button className={visitControl} type="button" onClick={() => setOpened(true)}>
          {m.identifiers_inspect_open({}, o)}
        </button>
      ) : (
        <>
          {!evidence && (
            <p role="status">
              {query.isFetching
                ? m.candidate_loading({}, o)
                : result?.kind === 'changed'
                  ? m.identifiers_origin_changed({}, o)
                  : result?.kind === 'missing'
                    ? m.identifiers_origin_missing({}, o)
                    : result?.kind === 'refused'
                      ? m.identifiers_origin_refused({}, o)
                      : m.identifiers_origin_unavailable({}, o)}
            </p>
          )}
          {evidence && inspection ? (
            <>
              {statement ? (
                <IdentifierOccurrence
                  evidence={evidence}
                  property={inspection.property}
                  statement={statement}
                  locale={locale}
                />
              ) : (
                <p role="status">{m.value_not_selected({}, o)}</p>
              )}
              <button
                className={visitControl}
                type="button"
                onClick={() => {
                  focusLease.current?.cancel();
                  focusLease.current = identifierReturnFocus(region.current!.ownerDocument, lifetime.active);
                  pending.current = {
                    focus: focusLease.current,
                    previous: evidence,
                    address: inspection,
                  };
                  setInspection(undefined);
                  void query.refetch();
                }}
              >
                {m.identifiers_inspect_return({}, o)}
              </button>
            </>
          ) : evidence ? (
            <>
              <p lang={pageText(evidence.subject.labels, locale).lang}>
                {pageText(evidence.subject.labels, locale).text}
              </p>
              {!evidence.properties.some((property) => evidence.subject.statements[property]?.length) && (
                <p>{m.identifiers_empty({}, o)}</p>
              )}
              {evidence.properties.map((property) => (
                <section key={property} className="min-w-0 space-y-3">
                  <h2
                    lang={pageText(evidence.definitions.properties[property]?.labels, locale).lang}
                    className="font-semibold"
                  >
                    {pageText(evidence.definitions.properties[property]?.labels, locale).text}
                  </h2>
                  {(evidence.subject.statements[property] ?? []).map((item, index) => {
                    const address = { property, statement: item.id };
                    return (
                      <div key={item.id} className="min-w-0 space-y-2 rounded border p-3">
                        <p>{m.facts_selected_value({ number: index + 1 }, o)}</p>
                        <CandidateValue snak={item} related={evidence.related} locale={locale} />
                        <button
                          type="button"
                          className={visitControl}
                          ref={(node) => {
                            const key = `${property}:${item.id}`;
                            if (node) targets.current.set(key, node);
                            else targets.current.delete(key);
                          }}
                          onClick={() => {
                            focusLease.current?.cancel();
                            setInspection(address);
                          }}
                        >
                          {m.identifiers_inspect_exact({}, o)}
                        </button>
                        <a className={visitControl} href={identifierInspectionHref(editorHref, address)}>
                          {m.identifiers_inspect_link({}, o)}
                        </a>
                      </div>
                    );
                  })}
                </section>
              ))}
            </>
          ) : null}
          <button
            type="button"
            className={visitControl}
            disabled={query.isFetching}
            onClick={() => {
              focusLease.current?.cancel();
              pending.current = undefined;
              setInspection(undefined);
              void query.refetch();
            }}
          >
            {m.identifiers_public_reload({}, o)}
          </button>
        </>
      )}
    </section>
  );
}

/** Existing fact values preserve the literal, qualifier ordering and separate reference groups. */
export function IdentifierOccurrence({
  evidence,
  property,
  statement,
  locale,
}: {
  evidence: IdentifierEvidence;
  property: string;
  statement: NonNullable<ReturnType<typeof identifierOccurrence>>;
  locale: string;
}) {
  const o = { locale: locale as never };
  const label = (id: string) =>
    pageText(evidence.definitions.properties[id]?.labels ?? evidence.related[id]?.labels, locale);
  return (
    <article data-slot="identifier-exact-occurrence" className="min-w-0 space-y-4">
      <dl className="space-y-3">
        <div>
          <dt>{m.identifiers_inspect_holder({}, o)}</dt>
          <dd lang={pageText(evidence.subject.labels, locale).lang}>
            {pageText(evidence.subject.labels, locale).text}
          </dd>
        </div>
        <div>
          <dt>{m.identifiers_inspect_property({}, o)}</dt>
          <dd lang={label(property).lang}>{label(property).text}</dd>
        </div>
        <div>
          <dt>{m.identifiers_inspect_rank({}, o)}</dt>
          <dd>{statement.rank === 'preferred' ? m.candidate_rank_preferred({}, o) : m.candidate_rank_normal({}, o)}</dd>
        </div>
      </dl>
      <CandidateValue snak={statement} related={evidence.related} locale={locale} />
      <dl className="space-y-2">
        {statement.qualifiers.map((part, index) => (
          <div key={index}>
            <dt lang={label(part.property.id).lang}>{label(part.property.id).text}</dt>
            <dd>
              <CandidateValue snak={part} related={evidence.related} locale={locale} />
            </dd>
          </div>
        ))}
      </dl>
      <ol className="space-y-3">
        {statement.references.map((reference, index) => (
          <li key={index} className="border-s-2 ps-3">
            <p>
              {m.correction_references({}, o)} {index + 1}
            </p>
            <dl>
              {reference.parts.map((part, partIndex) => (
                <div key={partIndex}>
                  <dt lang={label(part.property.id).lang}>{label(part.property.id).text}</dt>
                  <dd>
                    <CandidateValue snak={part} related={evidence.related} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </article>
  );
}
