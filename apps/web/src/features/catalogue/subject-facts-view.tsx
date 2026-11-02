import {
  catalogueEditor,
  useEditorLifetime,
  useEditorWorkspaceLifetime,
  useCurrentReadingVisible,
  useCurrentReadingActive,
} from './editor-lifetime';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode, RefObject } from 'react';
import {
  AuthoringDepartureBoundary,
  useAuthoringDeparture,
  type AuthoringLocation,
} from '../../threads/authoring-departure';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { pageText } from '../pages/data';
import { subjectHref } from '../../subject/subject-href';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { DefinitionGuideLink } from './definition-guide-view';
import { AuthoredFieldEntry } from './authored-field-entry';
import { EditorFailure, PartValue, StatementFields } from './statement-editor-view';
import type { EditorRead } from './statement-editor';
import {
  factChanged,
  factGroups,
  factLimit,
  factLocked,
  sealFacts,
  sendFacts,
  stageFact,
  type FactDraft,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';

// Profile-guided editors share the existing field controls, partial outcomes and exact review.
export { ExactReview };
export { SelectedFacts };

type ReviewAddress = { property: string; candidate: string; session?: string | undefined };
/** Refresh preserves an explicit source only while that exact statement remains selected. */
export function reconcileFactSource(source: string, selected: readonly { id: string }[]): string {
  return selected.some((statement) => statement.id === source) ? source : '';
}

export type FactsProfile = {
  properties: (read: FactsCurrent) => string[];
  title: string;
  intro: string;
  empty: string;
  path: string;
};
export { FactField };
function ExactReview({
  address,
  id,
  locale,
  review,
}: {
  address: ReviewAddress;
  id: string;
  locale: string;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const transport = useMemo(
    () => review(address.property, address.session),
    [review, address.property, address.session],
  );
  return (
    <CandidateReview
      id={id}
      locale={locale}
      initialProperty={address.property}
      exactCandidate={address.candidate}
      transport={transport}
    />
  );
}

/** Every public selected assertion stays distinct, including qualifiers and statement-level citations. */
function SelectedFacts({ property, read, locale }: { property: string; read: FactsCurrent; locale: string }) {
  const o = { locale: locale as never };
  const selected = read.public.subject.statements[property] ?? [];
  return (
    <section className="min-w-0 space-y-3 [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:whitespace-normal [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring">
      <ContentItemHeading level={4} className="text-sm font-semibold text-muted-foreground">
        {m.candidate_current({}, o)}
      </ContentItemHeading>
      {!selected.length && <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>}
      <ol className="min-w-0 space-y-3">
        {selected.map((statement, index) => (
          <li key={statement.id} className="min-w-0">
            <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
              <p className="text-sm font-semibold">{m.facts_selected_value({ number: index + 1 }, o)}</p>
              <div className="min-w-0 text-base leading-relaxed">
                <PartValue part={statement} read={read} locale={locale} />
              </div>
              <dl className="min-w-0 space-y-2 text-sm">
                {statement.qualifiers.map((part, index) => (
                  <div key={index} className="min-w-0 space-y-1">
                    <dt
                      className="text-muted-foreground"
                      lang={pageText(read.release.properties[part.property.id]?.labels, locale).lang}
                    >
                      {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
                        m.subject_value_unlabelled({}, o)}
                      :{' '}
                    </dt>
                    <dd className="min-w-0">
                      <PartValue part={part} read={read} locale={locale} />
                    </dd>
                  </div>
                ))}
              </dl>
              <ol className="min-w-0 space-y-3">
                {statement.references.map((reference, index) => (
                  <li key={index} className="min-w-0 space-y-1 border-s-2 border-border ps-3 text-sm">
                    <p className="text-muted-foreground">
                      {m.correction_references({}, o)} {index + 1}
                    </p>
                    <ul className="min-w-0 space-y-1">
                      {reference.parts.map((part, partIndex) => (
                        <li key={partIndex} className="min-w-0">
                          <PartValue part={part} read={read} locale={locale} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </ContentItemFrame>
          </li>
        ))}
      </ol>
    </section>
  );
}

// One captured-instance discard decision serves admitted fields and retained private assertions.
function FactDiscard({
  read,
  draft,
  busy,
  label,
  locale,
  row,
  onDiscard,
}: {
  read: FactsCurrent;
  draft: FactDraft;
  busy: boolean;
  label: string;
  locale: string;
  row: RefObject<HTMLElement | null>;
  onDiscard: (draft: FactDraft) => void;
}) {
  const o = { locale: locale as never };
  const locked = factLocked(draft);
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<{ draft: FactDraft; read: FactsCurrent; active: () => boolean } | null>(null);
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const latest = useRef({ draft, read, busy, visible, onDiscard });
  latest.current = { draft, read, busy, visible, onDiscard };
  const confirming = !!pending && pending.draft === draft && pending.read === read && pending.active();
  if (pending && !confirming) setPending(null);
  useLayoutEffect(() => {
    if (confirming && !busy) cancel.current?.focus();
  }, [confirming, busy]);
  function cancelDiscard() {
    const now = latest.current;
    if (
      !pending ||
      !pending.active() ||
      !active() ||
      !now.visible ||
      now.busy ||
      now.read !== pending.read ||
      now.draft !== pending.draft ||
      !row.current?.isConnected
    )
      return;
    flushSync(() => setPending(null));
    discardTrigger.current?.focus();
  }
  function discard() {
    const now = latest.current;
    if (
      !pending ||
      !pending.active() ||
      !active() ||
      !now.visible ||
      now.busy ||
      now.read !== pending.read ||
      now.draft !== pending.draft ||
      now.draft.command ||
      factLocked(now.draft) ||
      !row.current?.isConnected
    )
      return;
    const form = row.current.closest('form');
    flushSync(() => {
      now.onDiscard?.(pending.draft);
      setPending(null);
    });
    const selector =
      'select:not(:disabled), button:not(:disabled):not([hidden]), input:not(:disabled):not([type="hidden"])';
    (row.current?.querySelector<HTMLElement>(selector) ?? form?.querySelector<HTMLElement>(selector))?.focus();
  }
  return (
    <div className="space-y-2">
      <Button
        ref={discardTrigger}
        type="button"
        variant="outline"
        hidden={confirming}
        disabled={busy || locked || !!draft.command}
        className="h-auto min-h-11 max-w-full whitespace-normal break-words"
        onClick={() => {
          const now = latest.current;
          if (
            active() &&
            now.visible &&
            !now.busy &&
            now.read === read &&
            now.draft === draft &&
            !!row.current?.isConnected &&
            !draft.command &&
            !factLocked(draft)
          )
            setPending({ draft, read, active });
        }}
      >
        {m.album_remove_draft({ field: label }, o)}
      </Button>
      {confirming && (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.album_remove_draft({ field: label }, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelDiscard();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.album_remove_draft({ field: label }, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={cancel} type="button" variant="outline" disabled={busy} onClick={cancelDiscard}>
              {m.candidate_cancel({}, o)}
            </Button>
            <Button type="button" variant="destructive" disabled={busy || locked || !!draft.command} onClick={discard}>
              {m.album_remove_draft({ field: label }, o)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FactField({
  property,
  read,
  locale,
  draft,
  busy,
  canStage,
  onStage,
  onChange,
  onDiscard,
  href,
  editorHref,
  onReview,
}: {
  property: string;
  read: FactsCurrent;
  locale: string;
  draft?: FactDraft | undefined;
  busy: boolean;
  canStage: boolean;
  onStage: (source: string | null) => void;
  onChange: (draft: FactDraft) => void;
  onDiscard?: ((draft: FactDraft) => void) | undefined;
  href: string;
  editorHref?: string | undefined;
  onReview: (address: ReviewAddress) => void;
}) {
  const o = { locale: locale as never };
  const visible = useCurrentReadingVisible();
  const active = useCurrentReadingActive();
  const definition = read.release.properties[property]!;
  const label = pageText(definition.labels, locale).text || m.subject_value_unlabelled({}, o);
  const selected = read.public.subject.statements[property] ?? [];
  const selection = JSON.stringify(selected.map((statement) => statement.id));
  const [choice, setChoice] = useState({
    source: selected.length === 1 ? selected[0]!.id : '',
    unavailable: false,
    selection,
  });
  const { source, unavailable: sourceUnavailable } = choice;
  if (choice.selection !== selection) {
    const next = reconcileFactSource(choice.source, selected);
    setChoice({
      source: next,
      unavailable: choice.unavailable || (!!choice.source && !next),
      selection,
    });
  }
  const sourceId = useId();
  const recoveryId = useId();
  const includeId = useId();
  // A withdrawn correction must never fall through to staging an additional assertion.
  const sourceSelected = selected.some((statement) => statement.id === source);
  const canEdit = canStage && !busy && (sourceSelected || (!selected.length && !sourceUnavailable));
  const sourceIndex = draft?.source ? selected.findIndex((item) => item.id === draft.source) : -1;
  const locked = !!draft && factLocked(draft);
  const row = useRef<HTMLElement>(null);
  if (!visible) return null;
  return (
    <section ref={row} aria-label={label} className="min-w-0 [overflow-wrap:anywhere]">
      <ContentItemFrame as="div" className="min-w-0 space-y-4 rounded-xl bg-card p-4 sm:p-5">
        <div lang={pageText(definition.labels, locale).lang}>
          <ContentItemHeading level={3} className="text-lg font-semibold">
            {label}
          </ContentItemHeading>
        </div>
        <p className="text-sm text-muted-foreground">
          {definition.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
        </p>
        <SelectedFacts property={property} read={read} locale={locale} />
        {!draft ? (
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {sourceUnavailable && (
              <p id={recoveryId} role="status" className="w-full text-sm text-muted-foreground">
                {m.facts_source_unavailable({}, o)}
              </p>
            )}
            {(!!selected.length || sourceUnavailable) && (
              <Field className="w-full min-w-0">
                <FieldLabel className="min-w-0 flex-wrap [overflow-wrap:anywhere]" htmlFor={sourceId}>
                  {m.facts_choose_value({}, o)}
                </FieldLabel>
                <NativeSelect
                  id={sourceId}
                  className="w-full min-w-0 [&>select]:min-h-11"
                  aria-label={m.facts_choose_value({}, o)}
                  aria-describedby={sourceUnavailable ? recoveryId : undefined}
                  aria-invalid={sourceUnavailable}
                  disabled={busy || !canStage || !selected.length}
                  value={source}
                  onChange={(event) => {
                    if (!active()) return;
                    const next = event.target.value;
                    setChoice({
                      source: next,
                      selection,
                      unavailable: sourceUnavailable && !selected.some((statement) => statement.id === next),
                    });
                  }}
                >
                  <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                  {selected.map((statement, index) => (
                    <NativeSelectOption key={statement.id} value={statement.id}>
                      {m.facts_selected_value({ number: index + 1 }, o)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
            <div className="flex min-w-0 flex-col flex-wrap gap-2 sm:flex-row sm:flex-wrap">
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                disabled={!canEdit}
                onClick={() => {
                  if (canEdit) onStage(sourceSelected ? source : null);
                }}
              >
                {m.facts_edit_field({}, o)}
              </Button>
              {(!!selected.length || sourceUnavailable) && definition.multivalued && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                  disabled={busy || !canStage}
                  onClick={() => onStage(null)}
                >
                  {m.facts_add_value({}, o)}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="min-w-0 space-y-4 border-t border-border pt-4">
            <ContentItemHeading level={4} className="text-base font-semibold">
              {m.facts_private({}, o)}
              {draft.source && (
                <>
                  {' '}
                  ·{' '}
                  {sourceIndex >= 0
                    ? m.facts_selected_value({ number: sourceIndex + 1 }, o)
                    : m.correction_stale({}, o)}
                </>
              )}
            </ContentItemHeading>
            {!draft.result?.ok && (
              <fieldset disabled={busy || locked} className="space-y-5">
                <StatementFields
                  heading="h4"
                  draft={draft.statement}
                  current={{ ...read, source: selected.find((item) => item.id === draft.source) ?? null }}
                  locale={locale}
                  change={(statement) => onChange({ ...draft, statement, command: undefined, result: undefined })}
                  guideReturn={`${href}/edit`}
                  {...(editorHref ? { guideReturn: editorHref } : {})}
                />
              </fieldset>
            )}
            {!draft.result?.ok && (
              <Field orientation="horizontal" className="min-w-0">
                <Checkbox
                  id={includeId}
                  className="size-11 after:inset-0"
                  checked={draft.included}
                  disabled={busy || locked}
                  onCheckedChange={(included) => onChange({ ...draft, included: included === true })}
                />
                <FieldLabel
                  className="min-h-11 min-w-0 items-center whitespace-normal [overflow-wrap:anywhere]"
                  htmlFor={includeId}
                >
                  {m.facts_include({}, o)}
                </FieldLabel>
              </Field>
            )}
            {!factChanged(draft) && <p className="text-sm text-muted-foreground">{m.facts_unchanged({}, o)}</p>}
            {onDiscard && (
              <FactDiscard
                read={read}
                draft={draft}
                busy={busy}
                label={label}
                locale={locale}
                row={row}
                onDiscard={onDiscard}
              />
            )}
            {draft.result && (
              <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4" role="status">
                {draft.result.ok ? (
                  <>
                    <p className="font-semibold">{m.correction_proposed({}, o)}</p>
                    <a
                      href={`${href}/edit?${new URLSearchParams({ reviewProperty: property, candidate: draft.result.candidate })}`}
                      {...(editorHref
                        ? {
                            href: `${editorHref}?${new URLSearchParams({ reviewProperty: property, candidate: draft.result.candidate })}`,
                          }
                        : {})}
                      className={buttonVariants({
                        variant: 'outline',
                        className: 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2',
                      })}
                      onClick={(event) => {
                        if (
                          event.button === 0 &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey
                        ) {
                          event.preventDefault();
                          if (draft.result?.ok)
                            onReview({ property, candidate: draft.result.candidate, session: draft.result.session });
                        }
                      }}
                    >
                      {m.correction_review({}, o)}
                    </a>
                  </>
                ) : (
                  <>
                    {draft.result.reason === 'uncertain' ? (
                      <p>{m.facts_uncertain({}, o)}</p>
                    ) : (
                      <EditorFailure reason={draft.result.reason} locale={locale} />
                    )}
                    {draft.result.reason === 'invalid' && (
                      <p>
                        {m.correction_invalid_part({}, o)} {label}
                      </p>
                    )}
                  </>
                )}
              </ContentItemFrame>
            )}
          </div>
        )}
      </ContentItemFrame>
    </section>
  );
}

/** Withdrawn metadata cannot authorize an editor or public reading; only the contributor's holder survives. */
function ExcludedFact({
  draft,
  read,
  locale,
  label,
  busy,
  onDiscard,
}: {
  draft: FactDraft;
  read: FactsCurrent;
  locale: string;
  label: ReturnType<typeof pageText> | undefined;
  busy: boolean;
  onDiscard: (draft: FactDraft) => void;
}) {
  const row = useRef<HTMLElement>(null);
  const o = { locale: locale as never };
  const title = label?.text || draft.property;
  return (
    <section ref={row} aria-label={title} className="min-w-0 space-y-3 rounded-xl bg-card p-4 [overflow-wrap:anywhere]">
      <ContentItemHeading level={2} lang={label?.lang} className="font-semibold">
        {title}
      </ContentItemHeading>
      <p>{m.facts_private({}, o)}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
        {JSON.stringify(draft.statement, null, 2)}
      </pre>
      {draft.result &&
        (draft.result.ok ? (
          <p role="status">{m.correction_proposed({}, o)}</p>
        ) : (
          <EditorFailure reason={draft.result.reason} locale={locale} />
        ))}
      <FactDiscard
        read={read}
        draft={draft}
        busy={busy}
        label={title}
        locale={locale}
        row={row}
        onDiscard={onDiscard}
      />
    </section>
  );
}

export const SubjectFacts = catalogueEditor(SubjectFactsWorkspace);

// A same-route address change can replace this workspace with a single-field editor.
const factWorkspaceAddress = (location: AuthoringLocation) => JSON.stringify([location.pathname, location.search]);

function SubjectFactsWorkspace(props: Parameters<typeof SubjectFactsLive>[0]) {
  if (props.profile) return <SubjectFactsLive {...props} />;
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={factWorkspaceAddress}>
      <SubjectFactsLive {...props} />
    </AuthoringDepartureBoundary>
  );
}

function SubjectFactsLive({
  initial,
  locale,
  transport,
  review,
  initialReview,
  profile,
  profileIntro,
  profileRelations,
  embedded = false,
  onReload,
}: {
  initial: EditorRead;
  locale: string;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  initialReview?: ReviewAddress | undefined;
  profile?: FactsProfile | undefined;
  profileIntro?: ReactNode;
  profileRelations?: ReactNode;
  embedded?: boolean;
  /** A whole-profile owner refreshes identity and facts under the same read authority. */
  onReload?: () => void;
}) {
  const lifetime = useEditorLifetime();
  const workspace = useEditorWorkspaceLifetime();
  const visible = useCurrentReadingVisible();
  const o = { locale: locale as never };
  const [read, setRead] = useState(initial);
  const [previousInitial, setPreviousInitial] = useState(initial);
  // A refreshed session read retains the workspace's sealed commands and drafts.
  if (previousInitial !== initial) {
    setPreviousInitial(initial);
    setRead(initial);
  }
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(initialReview);
  const running = useRef(false);
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible)
      setDrafts((previous) =>
        previous.map((draft) =>
          draft.command && !draft.result ? { ...draft, result: { ok: false, reason: 'uncertain' } } : draft,
        ),
      );
  }
  const current = read.ok ? read : null;
  const subject = current?.public.subject;
  const label = pageText(subject?.labels, locale).text || m.subject_value_unlabelled({}, o);
  const href = subject ? subjectHref({ id: subject.id, label }, locale).href : '';
  const groups = current ? factGroups(current) : { text: [], time: [], quantity: [] };
  const editorHref = profile ? `${href}/${profile.path}` : undefined;
  if (profile && current) {
    const scope = new Set(profile.properties(current));
    for (const group of Object.keys(groups) as (keyof typeof groups)[])
      groups[group] = groups[group].filter((property) => scope.has(property));
  }
  const admitted = new Set(Object.values(groups).flat());
  const excluded = drafts.filter((draft) => !admitted.has(draft.property));
  const staleDraft = !!excluded.length;
  const draftLabels = useRef(new Map<string, ReturnType<typeof pageText>>());
  const discardState = useRef({ current, busy });
  discardState.current = { current, busy };
  function discard(original: FactDraft) {
    const now = discardState.current;
    if (!lifetime.active() || !now.current || now.current !== current || now.busy || running.current) return;
    setDrafts((previous) => previous.filter((item) => item !== original || !!item.command || factLocked(item)));
  }
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  const success = drafts.filter((draft) => draft.result?.ok).length;
  // Inclusion controls the next batch, never ownership of an unfinished assertion.
  // Observing these drafts must not validate, seal or send a proposal.
  const unresolved = () =>
    drafts.some(
      (draft) =>
        !!draft.command &&
        (!draft.result || (!draft.result.ok && ['uncertain', 'unavailable'].includes(draft.result.reason))),
    );
  useAuthoringDeparture(
    () =>
      !profile &&
      workspace.active() &&
      (unresolved() || drafts.some((draft) => !draft.result?.ok && factChanged(draft))),
    unresolved,
    String(workspace.generation),
    undefined,
    () => {
      if (profile) return;
      workspace.retire();
      running.current = false;
      setBusy(false);
      setDrafts([]);
      setReviewing(undefined);
    },
    undefined,
    undefined,
    factWorkspaceAddress,
  );
  function change(next: FactDraft) {
    if (!lifetime.active()) return;
    setDrafts((previous) => previous.map((item) => (item.property === next.property ? next : item)));
  }
  async function submit() {
    if (!lifetime.active()) return;
    if (!current || running.current || !changed.length) return;
    if (staleDraft) return;
    running.current = true;
    const sealed = sealFacts(current.public.subject.id, current.release, drafts);
    setDrafts(sealed);
    setBusy(true);
    try {
      await sendFacts(
        sealed,
        (command) => {
          if (!lifetime.active()) throw new Error('Retired catalogue editor');
          return transport.propose(command);
        },
        (property, result) =>
          lifetime.active() &&
          setDrafts((previous) =>
            previous.map((draft) => (draft.property === property ? { ...draft, result } : draft)),
          ),
      );
      if (!lifetime.active()) return;
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (!lifetime.active()) return;
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.read();
      if (!lifetime.active()) return;
      setRead(next);
    } catch {
      if (!lifetime.active()) return;
      setRead({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  const groupLabels = { text: m.facts_text({}, o), time: m.facts_dates({}, o), quantity: m.facts_quantities({}, o) };
  if (!visible || !workspace.active()) return null;
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 p-4 sm:p-6 [overflow-wrap:anywhere]"
      aria-busy={busy}
    >
      {!embedded && (
        <header className="space-y-3">
          {profile ? (
            <h1 className="font-sans text-2xl font-semibold">{profile.title}</h1>
          ) : (
            <h1 className="text-2xl font-semibold">{m.facts_title({}, o)}</h1>
          )}
          {subject && (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span lang={pageText(subject.labels, locale).lang}>
                <a
                  href={href}
                  className="inline-flex min-h-11 min-w-11 max-w-full items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {label}
                </a>
              </span>
              <span
                lang={pageText(current?.release.types[subject.type]?.labels, locale).lang}
                className="text-muted-foreground"
              >
                {pageText(current?.release.types[subject.type]?.labels, locale).text}
              </span>
            </p>
          )}
          {profile ? (
            <p className="text-sm text-muted-foreground">{profile.intro}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{m.facts_intro({}, o)}</p>
          )}
          <p className="text-sm text-muted-foreground">{m.correction_global({}, o)}</p>
          {profileIntro}
          {profile && subject && (
            <DefinitionGuideLink locale={locale} address={{ type: subject.type, returnTo: editorHref! }} />
          )}
          {!profile && (
            <>
              {subject && (
                <DefinitionGuideLink locale={locale} address={{ type: subject.type, returnTo: `${href}/edit` }} />
              )}
            </>
          )}
        </header>
      )}
      {!read.ok && <EditorFailure reason={read.reason} locale={locale} />}
      {current && (
        <>
          <nav
            aria-label={m.facts_other_editors({}, o)}
            className="flex min-w-0 flex-wrap gap-3 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:break-words [&_a]:py-2"
          >
            <a className={buttonVariants({ variant: 'outline' })} href={`${href}/terms`}>
              {m.catalogue_terms_title({}, o)}
            </a>
            <a className={buttonVariants({ variant: 'outline' })} href={`${href}/relation-edit`}>
              {m.relation_title({}, o)}
            </a>
            {current.release.types[subject!.type]?.properties.some(
              (id) => current.release.properties[id]?.datatype === 'document',
            ) && <AuthoredFieldEntry id={subject!.id} title={label} locale={locale} />}
            <a className={buttonVariants({ variant: 'ghost' })} href={href}>
              {m.candidate_view_public({}, o)}
            </a>
          </nav>
          {profile && !Object.values(groups).some((properties) => properties.length) && <p>{profile.empty}</p>}
          {!profile && (
            <>{!Object.values(groups).some((properties) => properties.length) && <p>{m.facts_empty({}, o)}</p>}</>
          )}
          {staleDraft && <EditorFailure reason="stale" locale={locale} />}
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {excluded.map((draft) => (
              <ExcludedFact
                key={draft.property}
                draft={draft}
                read={current}
                locale={locale}
                label={draftLabels.current.get(draft.property)}
                busy={busy}
                onDiscard={discard}
              />
            ))}
            <fieldset disabled={staleDraft} className="space-y-6">
              {Object.entries(groups)
                .filter(([, properties]) => properties.length)
                .map(([group, properties]) => (
                  <section key={group} className="space-y-4">
                    <ContentItemHeading level={2} className="text-xl font-semibold">
                      {groupLabels[group as keyof typeof groupLabels]}
                    </ContentItemHeading>
                    {properties.map((property) => (
                      <FactField
                        key={property}
                        property={property}
                        read={current}
                        locale={locale}
                        href={href}
                        editorHref={editorHref}
                        busy={busy}
                        canStage={drafts.length < factLimit}
                        draft={drafts.find((draft) => draft.property === property)}
                        onChange={change}
                        onDiscard={discard}
                        onReview={(address) => {
                          if (lifetime.active()) setReviewing(address);
                        }}
                        onStage={(source) => {
                          if (!lifetime.active()) return;
                          const draft = stageFact(current, property, source);
                          if (draft)
                            draftLabels.current.set(
                              property,
                              pageText(current.release.properties[property]!.labels, locale),
                            );
                          if (draft)
                            setDrafts((previous) => (previous.length < factLimit ? [...previous, draft] : previous));
                        }}
                      />
                    ))}
                  </section>
                ))}
              <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5">
                <ContentItemHeading level={2} className="text-lg font-semibold">
                  {m.facts_selection({ count: changed.length, limit: factLimit }, o)}
                </ContentItemHeading>
                <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
                {!!success && <p role="status">{m.facts_results({ count: success }, o)}</p>}
                {busy && <p role="status">{m.correction_saving({}, o)}</p>}
                <Button
                  type="submit"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                  disabled={busy || !changed.length}
                >
                  {m.facts_submit({}, o)}
                </Button>
              </ContentItemFrame>
            </fieldset>
          </form>
          {profileRelations}
          {(!profile || admitted.has(reviewing?.property ?? '')) && (
            <>
              {reviewing && (
                <ExactReview
                  key={`${reviewing.property}:${reviewing.candidate}`}
                  id={subject!.id}
                  locale={locale}
                  address={reviewing}
                  review={review}
                />
              )}
            </>
          )}
        </>
      )}
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
        disabled={busy && !onReload}
        onClick={() => (onReload ? onReload() : void reload())}
      >
        {m.correction_reload({}, o)}
      </Button>
    </article>
  );
}
