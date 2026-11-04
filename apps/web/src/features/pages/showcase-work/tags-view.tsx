import { useId, useLayoutEffect, useRef } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { useIncarnationState } from '@rezics/ui/cover';
import { m } from '../../../paraglide/messages.js';
import { subjectHref, subjectUrlForView } from '../../../subject/subject-href';
import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import type { Related, Subject } from '../../../subject/types';
import { StatementSummary } from '../../catalogue/statement-summary';
import { statementInput } from '../../catalogue/statement-editor';
import { catalogueEntries } from '../../catalogue/catalogue-entry';
import { pageText } from '../shared';
import { contextHref } from '../context-navigation';
import {
  subjectVisitReturn,
  withSubjectVisitReturn,
  workTagReturn,
  workTagReturnHref,
  type WorkTagReturn,
} from '../subject-visit-navigation';
import { readWorkTags, workTagPreviewLimit, type TagDefinitions, type WorkTag } from './tags';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-left [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass = `${buttonVariants({ variant: 'outline', size: 'sm' })} ${actionClass}`;

type Props = {
  subject: Subject;
  related: Related;
  definitions?: TagDefinitions | undefined;
  locale: string;
  spoilerThreshold: number;
  currentHref?: string | undefined;
  realm?: string | undefined;
};

/** Production observes the existing browser/session boundary; the renderer also remains usable in page stories. */
export const WorkConceptTagsRoute = candidateSession(function WorkConceptTagsRoute(props: Omit<Props, 'currentHref'>) {
  const currentHref = useLocation({ select: (location) => location.publicHref });
  return <SubjectConceptTags {...props} currentHref={currentHref} />;
});

function spoilerText(tag: WorkTag, locale: string) {
  const o = { locale: locale as never };
  switch (tag.spoiler) {
    case '0':
      return m.work_tags_spoiler_zero({}, o);
    case '1':
      return m.work_tags_spoiler_one({}, o);
    case '2':
      return m.work_tags_spoiler_two({}, o);
    default:
      return m.work_tags_spoiler_absent({}, o);
  }
}

function Weight({ tag, locale }: { tag: WorkTag; locale: string }) {
  const o = { locale: locale as never };
  switch (tag.weight.state) {
    case 'source':
      return <span className="tabular-nums">{m.work_tags_source_weight({ amount: tag.weight.amount }, o)}</span>;
    case 'absent':
      return <span>{m.work_tags_weight_absent({}, o)}</span>;
    case 'unsupported':
      return <span>{m.work_tags_weight_unsupported({}, o)}</span>;
    case 'unavailable':
      return <span>{m.work_tags_weight_unavailable({}, o)}</span>;
  }
}

/** Supplied descriptions explain the release's meaning and retain their data language. */
function WeightMeaning({ tag, definitions, locale }: { tag: WorkTag; definitions: TagDefinitions; locale: string }) {
  const o = { locale: locale as never };
  const weight = pageText(definitions.properties['rezics:sourceTagWeight']?.descriptions, locale);
  const metric = pageText(definitions.properties['rezics:sourceTagWeightMetric']?.descriptions, locale);
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">
        <Weight tag={tag} locale={locale} />
      </p>
      {tag.weight.state === 'source' ? (
        <>
          <p>{m.work_tags_source_meaning({}, o)}</p>
          {weight.text && <p lang={weight.lang}>{weight.text}</p>}
          {metric.text && <p lang={metric.lang}>{metric.text}</p>}
        </>
      ) : (
        <p>{m.work_tags_weight_explanation({}, o)}</p>
      )}
    </div>
  );
}

function TagEvidence({
  tag,
  subject,
  related,
  definitions,
  locale,
  id,
  browseHref,
  onClose,
}: {
  tag: WorkTag;
  subject: Subject;
  related: Related;
  definitions: TagDefinitions;
  locale: string;
  id: string;
  browseHref: string;
  onClose: () => void;
}) {
  const o = { locale: locale as never };
  const input = { ...statementInput(tag.statement), rank: tag.statement.rank };
  const read = { release: definitions, source: tag.statement, public: { subject: { type: subject.type }, related } };
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="min-w-0 space-y-4 rounded-lg border border-border bg-muted/30 p-4 [overflow-wrap:anywhere]"
      data-slot="work-tag-evidence"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`${id}-heading`} className="min-w-0 text-base font-semibold">
          {m.work_tags_evidence_title({ tag: tag.label.text }, o)}
        </h3>
        <Button type="button" variant="ghost" className={actionClass} onClick={onClose}>
          {m.work_tags_evidence_close({}, o)}
        </Button>
      </div>
      <WeightMeaning tag={tag} definitions={definitions} locale={locale} />
      <p className="text-sm">{spoilerText(tag, locale)}</p>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{m.work_tags_assertion({}, o)}</dt>
          <dd>
            <code className="break-all">{tag.statement.id}</code>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{m.work_tags_original_subject({}, o)}</dt>
          <dd>
            <code className="break-all">{tag.originalId}</code>
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{m.work_tags_evidence_explanation({}, o)}</p>
      <StatementSummary statement={input} read={read} locale={locale} />
      <div className="flex flex-wrap gap-2">
        <a className={linkClass} href={browseHref}>
          {m.work_tags_browse({ tag: tag.label.text }, o)}
        </a>
      </div>
    </section>
  );
}

/**
 * A compact preview of the current admitted page. A source replacement resets the single evidence disclosure,
 * even if all serialized values are equal. No tag read, result cursor, command or hidden total is retained here.
 */
export function SubjectConceptTags({
  subject,
  related,
  definitions,
  locale,
  spoilerThreshold,
  currentHref,
  realm,
}: Props) {
  const heading = useId();
  const root = useRef<HTMLElement>(null);
  const source = useRef({ subject, related, definitions, generation: 0 });
  if (
    source.current.subject !== subject ||
    source.current.related !== related ||
    source.current.definitions !== definitions
  ) {
    source.current = { subject, related, definitions, generation: source.current.generation + 1 };
  }
  const lifetime = useCatalogueLifetime(
    JSON.stringify([
      'work-tags',
      subject.id,
      subject.release,
      subject.revision,
      subject.context,
      source.current.generation,
      locale,
      spoilerThreshold,
      currentHref,
      realm,
    ]),
  );
  const evidence = useIncarnationState<number | undefined>(String(lifetime.generation), () => undefined);
  const reading = readWorkTags(subject, related, definitions, locale, spoilerThreshold);
  const o = { locale: locale as never };
  const label = pageText(subject.labels, locale).text;
  const base = subjectHref({ id: subject.id, label }, locale);
  const fallbackHref = contextHref(base.href, realm);
  const returnHref = workTagReturnHref(currentHref, fallbackHref, locale);
  const detailsHref = withSubjectVisitReturn(
    contextHref(subjectUrlForView(base, 'details'), realm),
    returnHref,
    locale,
  );
  const visible = reading.state === 'ready' ? reading.tags.slice(0, workTagPreviewLimit) : [];

  // A return locator never opens evidence. Recheck current admission and the preference before restoring focus.
  useLayoutEffect(() => {
    if (!currentHref || !lifetime.active()) return;
    const accepted = subjectVisitReturn(currentHref, locale);
    if (!accepted) return;
    const hash = new URL(accepted, 'https://rezics.invalid').hash;
    if (hash === '#work-tags') {
      root.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      return;
    }
    const selection = workTagReturn(hash);
    if (!selection) return;
    const index =
      selection.spoiler === spoilerThreshold
        ? visible.findIndex((tag) => tag.statement.id === selection.statement && tag.property === selection.property)
        : -1;
    const target =
      index < 0
        ? root.current?.querySelector<HTMLElement>('h2')
        : root.current?.querySelector<HTMLElement>(
            `[data-tag-index="${index}"] [data-tag-action="${selection.focus}"]`,
          );
    if (target && (document.activeElement === document.body || document.activeElement === root.current)) {
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'nearest' });
    }
  }, [currentHref, lifetime.generation]);

  if (reading.state === 'unsupported') return null;
  const destination = (tag: WorkTag, focus: WorkTagReturn['focus']) => {
    const selection: WorkTagReturn = {
      property: tag.property,
      statement: tag.statement.id,
      spoiler: spoilerThreshold === 1 ? 1 : spoilerThreshold === 2 ? 2 : 0,
      focus,
    };
    const returnTo = workTagReturnHref(currentHref, fallbackHref, locale, selection);
    const address = catalogueEntries.concepts({ id: tag.originalId, label: tag.label.text, locale });
    const query = new URLSearchParams({ role: tag.property, returnTo });
    if (tag.qualifiers.length) query.set('tagQualifiers', JSON.stringify(tag.qualifiers));
    // This is the destination's existing disclosure preference, not a new qualifier/filter syntax.
    if (spoilerThreshold === 1 || spoilerThreshold === 2) query.set('spoiler', String(spoilerThreshold));
    return `${address.href}?${query}`;
  };
  return (
    <section
      ref={root}
      id="work-tags"
      data-slot="subject-concept-tags"
      className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      aria-labelledby={heading}
      onClickCapture={(event) => {
        if (!lifetime.active()) event.preventDefault();
      }}
    >
      <h2
        id={heading}
        tabIndex={-1}
        className="scroll-mt-24 font-sans text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.subject_tags({}, o)}
      </h2>
      {reading.state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.work_tags_unavailable({}, o)}
        </p>
      ) : (
        <>
          <p className="max-w-prose text-sm text-muted-foreground">{m.work_tags_preview({}, o)}</p>
          <p className="sr-only" role="status" aria-live="polite">
            {m.work_tags_current_reading({}, o)}
          </p>
          {visible.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.work_tags_empty({}, o)}
            </p>
          ) : (
            <ul className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((tag, index) => {
                const selected = evidence.value === index;
                const evidenceId = `${heading}-evidence-${index}`;
                const detailId = `${heading}-details-${index}`;
                const browseHref = destination(tag, 'browse');
                return (
                  <li
                    key={`${tag.property}:${tag.statement.id}:${index}`}
                    data-tag-index={index}
                    className="min-w-0 space-y-2 rounded-lg border border-border p-3"
                  >
                    <a
                      href={browseHref}
                      data-tag-action="browse"
                      className={`flex min-h-11 min-w-11 min-w-0 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline ${actionClass}`}
                    >
                      <span lang={tag.label.lang}>{tag.label.text}</span>
                    </a>
                    <p className="text-xs text-muted-foreground" lang={tag.role.lang}>
                      {tag.role.text || tag.property}
                    </p>
                    <div className="space-y-1 text-sm" id={detailId}>
                      <p>
                        <Weight tag={tag} locale={locale} />
                      </p>
                      <p className="text-muted-foreground">{spoilerText(tag, locale)}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={actionClass}
                      data-tag-action="evidence"
                      aria-expanded={selected}
                      aria-controls={selected ? evidenceId : undefined}
                      aria-describedby={detailId}
                      onClick={() => {
                        if (lifetime.active()) evidence.setValue(selected ? undefined : index);
                      }}
                    >
                      {m.work_tags_inspect({ tag: tag.label.text }, o)}
                    </Button>
                    {selected && definitions && (
                      <TagEvidence
                        tag={tag}
                        subject={subject}
                        related={related}
                        definitions={definitions}
                        locale={locale}
                        id={evidenceId}
                        browseHref={destination(tag, 'evidence')}
                        onClose={() => {
                          if (!lifetime.active()) return;
                          evidence.setValue(undefined);
                          root.current
                            ?.querySelector<HTMLElement>(`[data-tag-index="${index}"] [data-tag-action="evidence"]`)
                            ?.focus();
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-2 border-t border-border pt-3">
            <p className="max-w-prose text-sm text-muted-foreground">
              {reading.tags.length > workTagPreviewLimit
                ? m.work_tags_more_in_read({}, o)
                : m.work_tags_page_boundary({}, o)}
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <a className={linkClass} href={detailsHref}>
                {m.work_tags_details({}, o)}
              </a>
              {reading.properties.map((property) => {
                const role = pageText(definitions?.properties[property]?.labels, locale);
                const url = new URL(contextHref(subjectUrlForView(base, 'relations'), realm), 'https://rezics.invalid');
                url.searchParams.set('property', property);
                const href = withSubjectVisitReturn(`${url.pathname}${url.search}#connections`, returnHref, locale);
                return (
                  <a key={property} className={linkClass} href={href} lang={role.lang}>
                    {m.work_tags_relation_reader({ role: role.text || property }, o)}
                  </a>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
