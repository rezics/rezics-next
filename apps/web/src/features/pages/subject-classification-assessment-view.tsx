import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button } from '@rezics/ui/shadcn/button';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import { valueExplanationHref } from '../catalogue/value-explanation';
import { OverviewContext } from './overview';
import {
  canEditClassification,
  retryableClassificationCommand,
  type ClassificationAssessmentSession,
  type ClassificationAssessmentSnapshot,
} from './subject-classification-assessment-controller';
import {
  captureClassificationCommand,
  type ClassificationCommand,
  type ClassificationCommandOutcome,
} from './subject-classification-assessment-commands';
import {
  CLASSIFICATION_ASSESSMENT_PROVIDERS,
  publicAggregateProjection,
  type ClassificationAggregate,
  type ClassificationAssociationIdentity,
  type ClassificationOwnOutcome,
  type DisclosedClassificationAssociation,
} from './subject-classification-assessment';
import { providerStatisticLabel, type Statistic } from './subject-ratings';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const sectionClass = 'min-w-0 space-y-4 in-data-[density=compact]:space-y-3';
const headingClass =
  'text-2xl leading-snug font-semibold tracking-tight text-balance in-data-[heading-scale=lg]:text-3xl';
const summaryClass =
  'list-item list-inside min-h-11 min-w-11 max-w-full cursor-pointer rounded-sm px-2 py-3 text-start text-sm font-medium whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export const ClassificationAssessmentContext = createContext<ClassificationAssessmentSnapshot | null>(null);
export const ClassificationAssessmentSelectionContext = createContext<DisclosedClassificationAssociation[] | null>(
  null,
);
export const ClassificationAssessmentHandlerContext = createContext<ClassificationAssessmentHandlers | null>(null);
export const ClassificationAssessmentChromeContext = createContext<{
  csrfToken: string | null;
  returnTo: string;
  title: string;
} | null>(null);

export type ClassificationAssessmentHandlers = {
  onSelect: (identity: ClassificationAssociationIdentity | null) => void;
  onCommand: (command: ClassificationCommand) => void;
  onRetry: () => void;
};

function localeOptions(locale: string) {
  return { locale: locales.find((item) => item === locale) ?? 'en' };
}

function ownStatusText(own: ClassificationOwnOutcome, locale: string): string {
  const options = localeOptions(locale);
  if (own.kind === 'preparing') return m.subject_classification_assessment_preparing({}, options);
  if (own.kind === 'signed-out') return m.subject_classification_assessment_signed_out({}, options);
  if (own.kind === 'absent') return m.subject_classification_assessment_absent({}, options);
  if (own.kind === 'pending') return m.subject_classification_assessment_pending({}, options);
  if (own.kind === 'denied') return m.subject_classification_assessment_denied({}, options);
  if (own.kind === 'concealed') return m.subject_classification_assessment_denied({}, options);
  if (own.kind === 'unavailable') return m.subject_classification_assessment_unavailable({}, options);
  if (own.kind === 'conflict') return m.subject_classification_assessment_conflict({}, options);
  if (own.kind === 'stale') return m.subject_classification_assessment_stale({}, options);
  if (own.value.assessment === 'oppose') return m.subject_classification_assessment_own_oppose({}, options);
  return m.subject_classification_assessment_own_support({}, options);
}

function AggregateResult({
  aggregate,
  locale,
}: {
  aggregate: ClassificationAssessmentSnapshot['aggregate'];
  locale: string;
}) {
  const options = localeOptions(locale);
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  if (aggregate.kind === 'preparing')
    return <p role="status">{m.subject_classification_assessment_preparing({}, options)}</p>;
  if (aggregate.kind === 'denied' || aggregate.kind === 'concealed')
    return <p role="status">{m.subject_classification_assessment_denied({}, options)}</p>;
  if (aggregate.kind === 'unavailable' || aggregate.kind === 'stale')
    return <p role="status">{m.subject_classification_assessment_unavailable({}, options)}</p>;
  const value = publicAggregateProjection(aggregate.value);
  if (value.state === 'suppressed')
    return (
      <p role="status" data-slot="classification-aggregate" data-state="suppressed">
        {m.subject_classification_assessment_suppressed({}, options)}
      </p>
    );
  const published = value as Extract<ClassificationAggregate, { state: 'published' }>;
  return (
    <div data-slot="classification-aggregate" data-state="published" className="space-y-1 text-sm">
      <p>{m.subject_classification_assessment_published({}, options)}</p>
      {published.supportFraction !== null && (
        <p>
          {m.subject_classification_assessment_support_fraction(
            { fraction: number(published.supportFraction * 100, 1) },
            options,
          )}
        </p>
      )}
      <p>{m.subject_classification_assessment_support_count({ count: number(published.supportCount) }, options)}</p>
      <p>{m.subject_classification_assessment_oppose_count({ count: number(published.opposeCount) }, options)}</p>
      <p>{m.subject_classification_assessment_lie_count({ count: number(published.falsePositiveCount) }, options)}</p>
      <p>
        {m.subject_classification_assessment_as_of(
          { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(published.asOf)) },
          options,
        )}
      </p>
    </div>
  );
}

function ClassificationSourceReports({
  statistics,
  locale,
  sourcesHref,
}: {
  statistics: Statistic[];
  locale: string;
  sourcesHref: string;
}) {
  const options = localeOptions(locale);
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const date = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(
          parsed,
        )
      : value;
  };
  const rows = CLASSIFICATION_ASSESSMENT_PROVIDERS.flatMap((provider) => {
    const item = statistics.find((row) => row.source === provider);
    return item ? [item] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div data-slot="classification-source-reports" className="space-y-3 text-sm">
      {rows.map((item) => (
        <p
          key={item.source}
          data-slot="classification-source-report"
          data-provider={item.source}
          className="min-w-0 break-words"
        >
          <MetaLine
            items={[
              <span className="font-medium">{providerStatisticLabel(item.source)}</span>,
              <strong className="tabular-nums">
                {number(item.mean, 2)} ({number(item.scale.min)}–{number(item.scale.max)})
              </strong>,
              m.subject_ratings_imported({ count: number(item.count), date: date(item.asOf) }, options),
              item.sourceRecordId ? (
                <a className="text-primary underline underline-offset-4" href={sourcesHref}>
                  {m.subject_classification_source_record({ record: item.sourceRecordId }, options)}
                </a>
              ) : null,
              item.sourceAlias && item.sourceAlias !== item.source
                ? m.subject_classification_source_alias({ alias: item.sourceAlias }, options)
                : null,
              item.observation
                ? m.subject_classification_source_unversioned({ digest: item.observation.digest.slice(0, 12) }, options)
                : null,
              item.licence ? m.rating_import_licence({ licence: item.licence }, options) : null,
              item.attribution ? m.rating_import_attribution({ attribution: item.attribution }, options) : null,
            ]}
          />
        </p>
      ))}
    </div>
  );
}

function AssessmentEditor({
  snapshot,
  locale,
  returnTo,
  csrfToken,
  onCommand,
  onRetry,
}: {
  snapshot: ClassificationAssessmentSnapshot;
  locale: string;
  returnTo: string;
  csrfToken: string | null;
  onCommand: (command: ClassificationCommand) => void;
  onRetry: () => void;
}) {
  const options = localeOptions(locale);
  const formId = useId();
  const own = snapshot.own;
  const current = own.kind === 'acknowledged' || own.kind === 'pending' || own.kind === 'absent' ? own.value : null;
  const [assessment, setAssessment] = useState<NonNullable<typeof current>['assessment']>(
    current?.assessment ?? 'support',
  );
  const [falsePositive, setFalsePositive] = useState(current?.falsePositive ?? false);
  const retry = retryableClassificationCommand(snapshot);
  const editable = canEditClassification(snapshot) && csrfToken !== null && snapshot.reader !== null;
  const uncertain = snapshot.command?.kind === 'uncertain';

  if (snapshot.session === 'signed-out')
    return (
      <a
        className={`inline-flex items-center text-sm font-medium text-primary underline underline-offset-4 ${actionClass}`}
        href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
      >
        {m.account_sign_in({}, options)}
      </a>
    );
  if (snapshot.session !== 'signed-in')
    return <p role="status">{m.subject_classification_assessment_preparing({}, options)}</p>;
  if (own.kind === 'denied' || own.kind === 'concealed')
    return <p role="status">{m.subject_classification_assessment_denied({}, options)}</p>;
  if (own.kind === 'unavailable')
    return <p role="status">{m.subject_classification_assessment_unavailable({}, options)}</p>;
  if (own.kind === 'conflict' || own.kind === 'stale') return <p role="status">{ownStatusText(own, locale)}</p>;

  const submit = (operands: ClassificationCommand['operands']) => {
    if (!snapshot.identity || !snapshot.reader || !csrfToken || !editable) return;
    onCommand(
      captureClassificationCommand({
        identity: snapshot.identity,
        expectedReader: snapshot.reader,
        csrfToken,
        operands,
      }),
    );
  };

  return (
    <form
      id={formId}
      className="min-w-0 space-y-3"
      data-slot="classification-assessment-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (uncertain && retry) {
          onRetry();
          return;
        }
        if (assessment) submit({ kind: 'set', assessment, falsePositive });
      }}
    >
      <fieldset className="min-w-0 space-y-2" disabled={!editable || uncertain}>
        <legend className="text-sm font-medium">{m.subject_classification_assessment_select({}, options)}</legend>
        <div className="flex flex-wrap gap-2">
          <label className={`inline-flex items-center gap-2 ${actionClass}`}>
            <input
              type="radio"
              name="assessment"
              value="support"
              checked={assessment === 'support'}
              onChange={() => setAssessment('support')}
            />
            {m.subject_classification_assessment_support({}, options)}
          </label>
          <label className={`inline-flex items-center gap-2 ${actionClass}`}>
            <input
              type="radio"
              name="assessment"
              value="oppose"
              checked={assessment === 'oppose'}
              onChange={() => setAssessment('oppose')}
            />
            {m.subject_classification_assessment_oppose({}, options)}
          </label>
        </div>
        <label className={`inline-flex items-center gap-2 ${actionClass}`}>
          <input
            type="checkbox"
            name="falsePositive"
            checked={falsePositive}
            onChange={(event) => setFalsePositive(event.currentTarget.checked)}
          />
          {m.subject_classification_assessment_lie({}, options)}
        </label>
      </fieldset>
      <p role="status" className="text-sm text-muted-foreground">
        {ownStatusText(own, locale)}
        {current?.falsePositive ? ` ${m.subject_classification_assessment_own_lie({}, options)}` : ''}
      </p>
      {uncertain && <p role="status">{m.subject_classification_assessment_uncertain({}, options)}</p>}
      <div className="flex flex-wrap gap-2">
        {uncertain && retry ? (
          <Button type="button" className={actionClass} onClick={onRetry}>
            {m.subject_classification_assessment_retry({}, options)}
          </Button>
        ) : (
          <>
            <Button type="submit" className={actionClass} disabled={!editable || !assessment}>
              {current?.hasBallot
                ? m.subject_classification_assessment_change({}, options)
                : m.subject_classification_assessment_support({}, options)}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              disabled={!editable || !current?.hasBallot}
              onClick={() => submit({ kind: 'withdraw' })}
            >
              {m.subject_classification_assessment_withdraw({}, options)}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

export function ClassificationAssessmentView({
  snapshot,
  associations,
  locale,
  title,
  returnTo,
  csrfToken,
  statistics = [],
  sourcesHref,
  onSelect,
  onCommand,
  onRetry,
}: {
  snapshot: ClassificationAssessmentSnapshot;
  associations: DisclosedClassificationAssociation[];
  locale: string;
  title: string;
  returnTo: string;
  csrfToken: string | null;
  statistics?: Statistic[];
  sourcesHref: string;
  onSelect: (identity: ClassificationAssociationIdentity | null) => void;
  onCommand: (command: ClassificationCommand) => void;
  onRetry: () => void;
}) {
  const options = localeOptions(locale);
  const selected = snapshot.identity
    ? associations.find(
        (item) =>
          item.associationId === snapshot.identity?.associationId &&
          item.subjectId === snapshot.identity.subjectId &&
          item.property === snapshot.identity.property &&
          item.targetId === snapshot.identity.targetId &&
          item.contextId === snapshot.identity.contextId &&
          item.qualifiersKey === snapshot.identity.qualifiersKey,
      )
    : undefined;
  const realm = snapshot.identity && snapshot.identity.contextId !== PAGE_GLOBAL_CONTEXT;

  return (
    <section
      data-slot="classification-assessment"
      aria-labelledby="classification-assessment-title"
      className={sectionClass}
    >
      <h2 id="classification-assessment-title" className={headingClass}>
        {m.subject_classification_assessment({}, options)}
      </h2>
      {associations.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.subject_classification_assessment_empty({}, options)}
        </p>
      ) : (
        <ul className="grid min-w-0 gap-2">
          {associations.map((item) => {
            const active =
              selected?.associationId === item.associationId && selected.qualifiersKey === item.qualifiersKey;
            return (
              <li key={`${item.associationId}:${item.qualifiersKey}`}>
                <Button
                  type="button"
                  variant={active ? 'default' : 'outline'}
                  aria-pressed={active}
                  className={actionClass}
                  onClick={() => onSelect(active ? null : item)}
                >
                  {item.propertyLabel}: {item.targetLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {realm && <p role="status">{m.subject_classification_assessment_realm({}, options)}</p>}
      {selected && !realm && (
        <ContentItemFrame as="div" className="min-w-0 space-y-3 wrap-anywhere py-3 sm:py-4">
          <ContentItemHeading level={3} className="text-[17px] leading-snug font-semibold sm:text-lg">
            {selected.propertyLabel}
          </ContentItemHeading>
          <p className="text-sm">{selected.targetLabel}</p>
          <details data-slot="classification-assessment-provenance" className="text-sm">
            <summary className={summaryClass}>{m.subject_classification_assessment_provenance({}, options)}</summary>
            <div className="mt-3 space-y-2 text-muted-foreground">
              <p>{selected.property}</p>
              <p>{selected.associationId}</p>
              {selected.release && <p>{selected.release}</p>}
              {selected.revision !== undefined && <p>{String(selected.revision)}</p>}
              <div className="flex flex-wrap gap-2">
                <a className={`text-primary underline underline-offset-4 ${actionClass}`} href={selected.inspectHref}>
                  {m.subject_classification_assessment_inspect({}, options)}
                </a>
                <a className={`text-primary underline underline-offset-4 ${actionClass}`} href={selected.changesHref}>
                  {m.subject_classification_assessment_changes({}, options)}
                </a>
              </div>
            </div>
          </details>
          <AssessmentEditor
            snapshot={snapshot}
            locale={locale}
            returnTo={returnTo}
            csrfToken={csrfToken}
            onCommand={onCommand}
            onRetry={onRetry}
          />
          <AggregateResult aggregate={snapshot.aggregate} locale={locale} />
          <ClassificationSourceReports statistics={statistics} locale={locale} sourcesHref={sourcesHref} />
        </ContentItemFrame>
      )}
    </section>
  );
}

export function ClassificationAssessmentSection({
  locale,
  title,
  returnTo,
  csrfToken,
  statistics,
  sourcesHref,
  session,
  handlers,
}: {
  locale: string;
  title: string;
  returnTo: string;
  csrfToken: string | null;
  statistics?: Statistic[];
  sourcesHref: string;
  session: ClassificationAssessmentSession;
  handlers: ClassificationAssessmentHandlers;
}) {
  const snapshot = useContext(ClassificationAssessmentContext);
  const page = useContext(OverviewContext);
  const associations = useContext(ClassificationAssessmentSelectionContext) ?? page?.classifications ?? [];
  const view = snapshot ?? {
    visit: 'idle',
    identity: null,
    reader: null,
    session,
    own: session === 'signed-out' ? { kind: 'signed-out' as const } : { kind: 'preparing' as const },
    aggregate: { kind: 'preparing' as const },
    command: null,
    cost: { nativeCalls: 0, valuesProcessed: 0, bytesRetained: 0 },
  };
  return (
    <ClassificationAssessmentView
      snapshot={view}
      associations={associations}
      locale={locale}
      title={title}
      returnTo={returnTo}
      csrfToken={csrfToken}
      {...(statistics ? { statistics } : {})}
      sourcesHref={sourcesHref}
      onSelect={handlers.onSelect}
      onCommand={handlers.onCommand}
      onRetry={handlers.onRetry}
    />
  );
}

export function classificationInspectHref(
  identity: ClassificationAssociationIdentity,
  title: string,
  locale: string,
): string {
  return valueExplanationHref(
    {
      id: identity.subjectId,
      title,
      property: identity.property,
      statement: identity.associationId,
      context: identity.contextId,
    },
    locale,
  );
}

export function classificationChangesHref(subjectId: string, title: string, locale: string): string {
  return catalogueEntries.changes({ id: subjectId, title, locale }).href;
}

export function ClassificationAssessControl({
  identity,
  locale,
}: {
  identity: ClassificationAssociationIdentity;
  locale: string;
}) {
  const handlers = useContext(ClassificationAssessmentHandlerContext);
  if (!handlers) return null;
  const options = localeOptions(locale);
  return (
    <Button type="button" variant="link" className={actionClass} onClick={() => handlers.onSelect(identity)}>
      {m.subject_classification_assessment({}, options)}
    </Button>
  );
}

export function ClassificationAssessmentProviders({
  associations,
  snapshot,
  handlers,
  chrome,
  children,
}: {
  associations?: DisclosedClassificationAssociation[] | null;
  snapshot: ClassificationAssessmentSnapshot | null;
  handlers?: ClassificationAssessmentHandlers;
  chrome?: { csrfToken: string | null; returnTo: string; title: string };
  children: ReactNode;
}) {
  const associationValue = useMemo(() => associations ?? null, [associations]);
  return (
    <ClassificationAssessmentSelectionContext.Provider value={associationValue}>
      <ClassificationAssessmentHandlerContext.Provider value={handlers ?? null}>
        <ClassificationAssessmentChromeContext.Provider value={chrome ?? null}>
          <ClassificationAssessmentContext.Provider value={snapshot}>
            {children}
          </ClassificationAssessmentContext.Provider>
        </ClassificationAssessmentChromeContext.Provider>
      </ClassificationAssessmentHandlerContext.Provider>
    </ClassificationAssessmentSelectionContext.Provider>
  );
}

export type { ClassificationCommandOutcome };
