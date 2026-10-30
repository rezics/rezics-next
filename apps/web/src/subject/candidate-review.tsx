import { useRef, useState } from 'react';
import { ContextComparisonView } from '../features/catalogue/context-curation-view';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { CandidateValue, pageText } from '../features/pages/data';
import { webUrl } from '../features/pages/shared';
import { m } from '../paraglide/messages.js';
import { subjectHref } from './subject-href';
import { candidateCanSelect, editCandidateDraft, refreshCandidateDraft, type CandidateDraft } from './candidate-draft';
import {
  candidateSourceRecords,
  publicCandidateSelection,
  type Candidate,
  type CandidateCommand,
  type CandidateFailure,
  type CandidateRead,
  type CandidateResult,
  type CandidateSlot,
} from './candidates';

export type CandidateTransport = {
  read: (property?: string, cursor?: string, session?: string) => Promise<CandidateRead>;
  confirm: (command: CandidateCommand) => Promise<CandidateResult>;
};

/** A session-only region: the owning subject route mounts it only after sign-in hydration. */
export function CandidateReview({
  id,
  locale,
  transport,
  initialProperty,
  exactCandidate,
  context,
  slot,
}: {
  id: string;
  locale: string;
  transport: CandidateTransport;
  initialProperty?: string | undefined;
  exactCandidate?: string;
  context?: string;
  slot?: CandidateSlot | undefined;
}) {
  const options = { locale: locale as never };
  const [opened, setOpened] = useState(false);
  const [read, setRead] = useState<CandidateRead>();
  const [property, setProperty] = useState(initialProperty ?? '');
  const [candidate, setCandidate] = useState<Candidate>();
  const [confirmation, setConfirmation] = useState<CandidateCommand['operation'] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CandidateDraft>>({});
  const [modes, setModes] = useState<Record<string, 'inherit' | 'replace' | 'suppress'>>({});
  const mode = modes[property] ?? 'replace';
  const [busy, setBusy] = useState(false);
  const [requiresReload, setRequiresReload] = useState(false);
  const [failure, setFailure] = useState<CandidateFailure>();
  const [result, setResult] = useState<CandidateResult & { ok: true }>();
  const request = useRef<CandidateCommand | null>(null);
  const running = useRef(false);
  const session = useRef<string | undefined>(undefined);
  const current = read?.ok ? read : undefined;
  const publicRead = context
    ? (result?.contextReview?.reading ?? current?.contextReview?.reading)
    : result
      ? result.public
      : current?.public;
  const draft = drafts[property];
  const maximum = current?.fields.find((field) => field.id === property)?.multivalued ? 32 : 1;
  const locked = busy || confirmation !== null || !!request.current || !!result;
  const publicStatements = (
    context
      ? (result?.contextReview?.selected ?? current?.contextReview?.selected ?? [])
      : (publicRead?.subject.statements[property] ?? [])
  ).filter((statement) => statement.rank === 'normal' || statement.rank === 'preferred');
  // Public values outside this page remain choices. No page ever stands in for the whole selection.
  const choices = new Map(publicStatements.map((statement) => [statement.id, { statement, eligible: true }]));
  for (const item of current?.page?.candidates ?? [])
    choices.set(item.id, { statement: item.statement, eligible: candidateCanSelect(item) });
  const valid =
    (context && mode !== 'replace') ||
    (!!draft &&
      draft.selection.length <= maximum &&
      draft.selection.every((entry) => choices.get(entry.candidate)?.eligible));
  const action =
    confirmation === 'reject'
      ? m.candidate_reject({}, options)
      : confirmation === 'adopt'
        ? m.candidate_adopt({}, options)
        : m.candidate_accept({}, options);

  async function load(field = property, cursor?: string) {
    if (running.current || request.current) return;
    running.current = true;
    setOpened(true);
    setBusy(true);
    setFailure(undefined);
    setConfirmation(null);
    setCandidate(undefined);
    setResult(undefined);
    try {
      const next = await transport.read(field || undefined, cursor, session.current);
      if (!next.ok) {
        setRead(undefined);
        setFailure(next);
        if (next.reason === 'denied') setDrafts({});
        return;
      }
      session.current = next.session ?? session.current;
      setRead(
        cursor && current?.page && next.page
          ? {
              ...next,
              page: {
                ...next.page,
                candidates: [
                  ...new Map(
                    [...current.page.candidates, ...next.page.candidates].map((item) => [item.id, item]),
                  ).values(),
                ],
              },
            }
          : next,
      );
      if (!cursor) setRequiresReload(false);
      if (context)
        setModes((previous) => ({
          ...previous,
          [field]:
            previous[field] ??
            next.page?.adoption?.mode ??
            (next.contextReview?.context.kind === 'community'
              ? (next.contextReview.context.defaults[field] ?? 'inherit')
              : 'replace'),
        }));
      if (field)
        setDrafts((previous) => ({
          ...previous,
          [field]: refreshCandidateDraft(
            previous[field],
            next.contextReview
              ? next.contextReview.selected.flatMap((statement) =>
                  statement.rank === 'normal' || statement.rank === 'preferred'
                    ? [{ candidate: statement.id, rank: statement.rank }]
                    : [],
                )
              : publicCandidateSelection(next.public, field),
          ),
        }));
      if (exactCandidate)
        setCandidate(next.page?.candidates.find((item) => item.id === exactCandidate && item.retracted === null));
    } catch {
      setRead(undefined);
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  async function confirm() {
    if (
      !current?.page ||
      !confirmation ||
      running.current ||
      requiresReload ||
      (confirmation === 'adopt' ? !valid : !candidate)
    )
      return;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    request.current ??= {
      id,
      property,
      // Adoption uses selection; candidate is retained for compatibility with existing scalar callers.
      candidate: candidate?.id ?? draft?.selection[0]?.candidate ?? id,
      operation: confirmation,
      head: confirmation === 'adopt' ? (current.page.adoption?.head ?? null) : candidate!.head,
      key: crypto.randomUUID(),
      ...(confirmation === 'adopt'
        ? { selection: context && mode !== 'replace' ? [] : structuredClone(draft!.selection) }
        : {}),
      ...(session.current ? { session: session.current } : {}),
      ...(context ? { context, mode, ...(slot ? { slot } : {}) } : {}),
    };
    try {
      const next = await transport.confirm(request.current);
      if (!next.ok) {
        setFailure(next);
        // An uncertain retry keeps the exact payload, old heads and key. A conflict never retries itself.
        if (next.reason !== 'unavailable') {
          setConfirmation(null);
          request.current = null;
          setRequiresReload(true);
        }
        if (next.reason === 'denied') {
          setRead(undefined);
          setCandidate(undefined);
          setDrafts({});
        }
      } else {
        session.current = next.session ?? session.current;
        setResult(next);
        setConfirmation(null);
        request.current = null;
        setRequiresReload(true);
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  function edit(choice: string, rank: 'normal' | 'preferred' | null) {
    if (locked || !draft) return;
    setDrafts((previous) => ({ ...previous, [property]: editCandidateDraft(previous[property]!, choice, rank) }));
  }

  function state(item: Candidate) {
    if (item.retracted !== null) return m.candidate_retracted({}, options);
    if (item.decision === 'rejected') return m.candidate_rejected_state({}, options);
    if (publicStatements.some((statement) => statement.id === item.id)) return m.candidate_selected({}, options);
    if (item.rank === 'normal' || item.rank === 'preferred') return m.candidate_pending({}, options);
    return item.decision === 'accepted' ? m.candidate_unselected({}, options) : m.candidate_unresolved({}, options);
  }

  return (
    <section
      id="candidate-review"
      aria-label={m.candidate_title({}, options)}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{m.candidate_title({}, options)}</h2>
        <p className="text-sm text-muted-foreground">{m.candidate_intro({}, options)}</p>
      </div>
      {!opened ? (
        <Button variant="outline" className="min-h-11" onClick={() => void load()}>
          {m.candidate_entry({}, options)}
        </Button>
      ) : (
        <>
          {busy && <p role="status">{m.candidate_loading({}, options)}</p>}
          {failure && (
            <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-3">
              <p>
                {failure.reason === 'stale'
                  ? m.candidate_draft_stale({}, options)
                  : failure.reason === 'denied'
                    ? m.candidate_denied({}, options)
                    : failure.reason === 'invalid'
                      ? m.candidate_invalid({}, options)
                      : m.candidate_unavailable({}, options)}
              </p>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void (request.current ? confirm() : load())}
              >
                {request.current ? m.candidate_retry({}, options) : m.candidate_reload({}, options)}
              </Button>
            </div>
          )}
          {result && (
            <div role="status" className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              {result.contextRefreshFailed && <p>{m.context_read_unavailable({}, options)}</p>}
              <p>
                {context && confirmation === null && result.kind !== 'accepted' && result.kind !== 'rejected'
                  ? m.context_saved({}, options)
                  : result.kind === 'selected'
                    ? m.candidate_selection_confirmed({}, options)
                    : result.kind === 'accepted'
                      ? m.candidate_accepted({}, options)
                      : result.kind === 'rejected'
                        ? m.candidate_rejected({}, options)
                        : m.candidate_pending({}, options)}
              </p>
              {!context && result.kind === 'selected' && result.public && (
                <a
                  className="underline underline-offset-4"
                  href={
                    subjectHref(
                      { id: result.public.subject.id, label: pageText(result.public.subject.labels, locale).text },
                      locale,
                    ).href
                  }
                >
                  {m.candidate_view_public({}, options)}
                </a>
              )}
              <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void load()}>
                {m.candidate_reload({}, options)}
              </Button>
            </div>
          )}
          {current && (
            <>
              {context && (
                <ContextComparisonView
                  read={result?.contextReview ? { ...current, contextReview: result.contextReview } : current}
                  property={property}
                  locale={locale}
                />
              )}
              <Field>
                <FieldLabel htmlFor="candidate-field">{m.candidate_field({}, options)}</FieldLabel>
                <NativeSelect
                  id="candidate-field"
                  className="min-h-11 w-full"
                  value={property}
                  disabled={locked || !!exactCandidate || !!slot}
                  onChange={(event) => {
                    setProperty(event.target.value);
                    void load(event.target.value);
                  }}
                >
                  <NativeSelectOption value="">{m.candidate_choose_field({}, options)}</NativeSelectOption>
                  {current.fields.map((field) => (
                    <NativeSelectOption key={field.id} value={field.id}>
                      {field.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {current.page && (
                <>
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">{m.candidate_compare_hint({}, options)}</p>
                    {(!current.page.candidates.length ||
                      (exactCandidate && !current.page.candidates.some((item) => item.id === exactCandidate))) && (
                      <p>{exactCandidate ? m.correction_exact_missing({}, options) : m.candidate_empty({}, options)}</p>
                    )}
                    {!candidate && (
                      <ul className="space-y-3">
                        {current.page.candidates
                          .filter((item) => !exactCandidate || item.id === exactCandidate)
                          .map((item) => (
                            <li key={item.id} className="space-y-3 rounded-lg border border-border p-3">
                              <CandidateValue
                                snak={item.statement}
                                related={(current.contextReview?.reading ?? current.public).related}
                                locale={locale}
                              />
                              <p className="text-sm text-muted-foreground">{state(item)}</p>
                              <CandidateProvenance candidate={item} read={current} locale={locale} />
                              <Button
                                variant="outline"
                                className="min-h-11"
                                disabled={locked || item.retracted !== null}
                                onClick={() => setCandidate(item)}
                              >
                                {m.candidate_review({}, options)}
                              </Button>
                            </li>
                          ))}
                      </ul>
                    )}
                    {current.page.next && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={locked || requiresReload}
                        onClick={() => void load(property, current.page!.next!)}
                      >
                        {m.candidate_more({}, options)}
                      </Button>
                    )}
                  </div>
                  {candidate && (
                    <div className="space-y-4">
                      <h3 className="font-semibold">{current.fields.find((field) => field.id === property)?.label}</h3>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3">
                          <h4 className="text-sm font-semibold">{m.candidate_current({}, options)}</h4>
                          {!publicRead ? (
                            <p>{m.candidate_public_unconfirmed({}, options)}</p>
                          ) : publicStatements.length ? (
                            publicStatements.map((statement) => (
                              <div key={statement.id}>
                                <CandidateValue snak={statement} related={publicRead.related} locale={locale} />
                              </div>
                            ))
                          ) : (
                            <p>{m.candidate_no_current({}, options)}</p>
                          )}
                        </div>
                        <div className="min-w-0 space-y-2 rounded-lg border border-primary/40 p-3">
                          <h4 className="text-sm font-semibold">{m.candidate_proposed({}, options)}</h4>
                          <CandidateValue
                            snak={candidate.statement}
                            related={(current.contextReview?.reading ?? current.public).related}
                            locale={locale}
                          />
                          <p className="text-sm text-muted-foreground">{state(candidate)}</p>
                          {candidate.statement.qualifiers.map((snak, index) => (
                            <div key={index}>
                              <span className="text-sm text-muted-foreground">
                                {pageText(current.names[snak.property.id], locale).text ||
                                  m.subject_value_unlabelled({}, options)}
                                :{' '}
                              </span>
                              <CandidateValue
                                snak={snak}
                                related={(current.contextReview?.reading ?? current.public).related}
                                locale={locale}
                              />
                            </div>
                          ))}
                          <CandidateProvenance candidate={candidate} read={current} locale={locale} />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {candidate.retracted === null && candidate.decision !== 'accepted' && (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={locked || requiresReload}
                            onClick={() => setConfirmation('accept')}
                          >
                            {m.candidate_accept({}, options)}
                          </Button>
                        )}
                        {candidate.retracted === null && candidate.decision !== 'rejected' && (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            disabled={locked || requiresReload}
                            onClick={() => setConfirmation('reject')}
                          >
                            {m.candidate_reject({}, options)}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          className="min-h-11"
                          disabled={locked}
                          onClick={() => setCandidate(undefined)}
                        >
                          {m.candidate_back({}, options)}
                        </Button>
                      </div>
                    </div>
                  )}
                  {draft && (
                    <section
                      aria-label={m.candidate_selection_draft({}, options)}
                      className="space-y-3 rounded-lg border border-border p-3"
                    >
                      <h3 className="font-semibold">{m.candidate_selection_draft({}, options)}</h3>
                      {context && current.contextReview && (
                        <Field>
                          <FieldLabel htmlFor="context-mode">{m.context_mode({}, options)}</FieldLabel>
                          <NativeSelect
                            id="context-mode"
                            value={mode}
                            disabled={locked || requiresReload}
                            onChange={(event) =>
                              setModes((previous) => ({ ...previous, [property]: event.target.value as typeof mode }))
                            }
                          >
                            <NativeSelectOption value="replace">{m.context_replace({}, options)}</NativeSelectOption>
                            {current.contextReview.context.kind === 'community' && (
                              <>
                                <NativeSelectOption value="inherit">
                                  {m.context_inherit({}, options)}
                                </NativeSelectOption>
                                <NativeSelectOption value="suppress">
                                  {m.context_suppress({}, options)}
                                </NativeSelectOption>
                              </>
                            )}
                          </NativeSelect>
                        </Field>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {context && mode !== 'replace'
                          ? m.context_empty_selection({}, options)
                          : m.candidate_replace_hint({}, options)}
                      </p>
                      <p className="text-sm">{m.candidate_selection_limit({ limit: String(maximum) }, options)}</p>
                      {(!context || mode === 'replace') && (
                        <ul className="space-y-3">
                          {[...new Set([...choices.keys(), ...draft.selection.map((entry) => entry.candidate)])].map(
                            (choice) => {
                              const value = choices.get(choice);
                              const entry = draft.selection.find((entry) => entry.candidate === choice);
                              return (
                                <li key={choice} className="space-y-2 rounded-lg bg-muted/30 p-3">
                                  <Field orientation="horizontal">
                                    <Checkbox
                                      id={`include-${choice}`}
                                      checked={!!entry}
                                      disabled={
                                        locked || (!entry && (!value?.eligible || draft.selection.length >= maximum))
                                      }
                                      onCheckedChange={(checked) => edit(choice, checked ? 'normal' : null)}
                                    />
                                    <FieldLabel htmlFor={`include-${choice}`} className="min-h-11 flex-wrap">
                                      <span>{m.candidate_include({}, options)}</span>
                                      {value ? (
                                        <CandidateValue
                                          snak={value.statement}
                                          related={(current.contextReview?.reading ?? current.public).related}
                                          locale={locale}
                                        />
                                      ) : (
                                        <span>{m.candidate_choice_unresolved({}, options)}</span>
                                      )}
                                    </FieldLabel>
                                  </Field>
                                  {entry && (
                                    <Field>
                                      <FieldLabel htmlFor={`rank-${choice}`}>
                                        {m.candidate_rank({}, options)}
                                      </FieldLabel>
                                      <NativeSelect
                                        id={`rank-${choice}`}
                                        className="min-h-11"
                                        value={entry.rank}
                                        disabled={locked || !value?.eligible}
                                        onChange={(event) => edit(choice, event.target.value as 'normal' | 'preferred')}
                                      >
                                        <NativeSelectOption value="normal">
                                          {m.candidate_rank_normal({}, options)}
                                        </NativeSelectOption>
                                        <NativeSelectOption value="preferred">
                                          {m.candidate_rank_preferred({}, options)}
                                        </NativeSelectOption>
                                      </NativeSelect>
                                    </Field>
                                  )}
                                </li>
                              );
                            },
                          )}
                        </ul>
                      )}
                      {!draft.selection.length && <p>{m.candidate_clear_selection({}, options)}</p>}
                      {!valid && <p role="status">{m.candidate_selection_invalid({}, options)}</p>}
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={locked || requiresReload || !valid}
                        onClick={() => setConfirmation('adopt')}
                      >
                        {m.candidate_adopt({}, options)}
                      </Button>
                    </section>
                  )}
                </>
              )}
            </>
          )}
          {confirmation && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <h4 className="font-semibold">{m.candidate_confirm_title({ action }, options)}</h4>
              <p className="text-sm">
                {confirmation === 'accept'
                  ? m.candidate_confirm_accept({}, options)
                  : confirmation === 'reject'
                    ? m.candidate_confirm_reject({}, options)
                    : context && mode !== 'replace'
                      ? m.context_empty_selection({}, options)
                      : m.candidate_confirm_replace({}, options)}
              </p>
              {context && confirmation === 'adopt' && (
                <p>
                  {mode === 'inherit'
                    ? m.context_inherit({}, options)
                    : mode === 'suppress'
                      ? m.context_suppress({}, options)
                      : m.context_replace({}, options)}
                </p>
              )}
              {confirmation === 'adopt' && (!context || mode === 'replace') && (
                <ul className="space-y-2">
                  {draft?.selection.map((entry) => {
                    const value = choices.get(entry.candidate);
                    return (
                      <li key={entry.candidate}>
                        {value && (
                          <CandidateValue snak={value.statement} related={current!.public.related} locale={locale} />
                        )}
                        <span className="ml-2 text-sm">
                          {entry.rank === 'preferred'
                            ? m.candidate_rank_preferred({}, options)
                            : m.candidate_rank_normal({}, options)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11" disabled={busy} onClick={() => void confirm()}>
                  {action}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={busy || !!request.current}
                  onClick={() => setConfirmation(null)}
                >
                  {m.candidate_cancel({}, options)}
                </Button>
              </div>
            </div>
          )}
          <Button
            variant="outline"
            className="min-h-11"
            disabled={locked}
            onClick={() => {
              setOpened(false);
              setRead(undefined);
              setCandidate(undefined);
              setResult(undefined);
              setFailure(undefined);
              setProperty(initialProperty ?? '');
            }}
          >
            {m.candidate_close({}, options)}
          </Button>
        </>
      )}
    </section>
  );
}

function CandidateProvenance({
  candidate,
  read,
  locale,
}: {
  candidate: Candidate;
  read: Extract<CandidateRead, { ok: true }>;
  locale: string;
}) {
  const options = { locale: locale as never };
  const source = candidate.source;
  const records = candidateSourceRecords(read.public.subject);
  const names: Record<string, string> = {
    bangumi: 'Bangumi',
    vndb: 'VNDB',
    openlibrary: 'Open Library',
    wikidata: 'Wikidata',
  };
  return (
    <div className="space-y-1 break-words text-sm text-muted-foreground">
      <p>
        {m.candidate_source({}, options)}:{' '}
        {source && 'source' in source ? (names[source.source] ?? source.source) : m.candidate_editorial({}, options)}
      </p>
      {source && 'source' in source && (
        <details>
          <summary className="cursor-pointer">{m.candidate_provenance({}, options)}</summary>
          <p>
            {m.candidate_record({}, options)}: {source.external_id}
          </p>
          <p>
            {m.candidate_source_revision({}, options)}: {source.record_revision}
          </p>
          <p>
            {m.candidate_converter({}, options)}: {source.converter_revision}
          </p>
        </details>
      )}
      {candidate.statement.references.map((reference, index) => (
        <div key={index}>
          {reference.parts.map((snak, part) => (
            <div key={part}>
              <CandidateValue snak={snak} related={read.public.related} locale={locale} />
            </div>
          ))}
        </div>
      ))}
      {records
        .filter((record) =>
          candidate.statement.references.some((reference) =>
            reference.parts.some((snak) => snak.value.type === 'value' && snak.value.content === record.url),
          ),
        )
        .map((record, index) => (
          <div key={index}>
            {record.url && webUrl(record.url) ? (
              <a className="underline" href={record.url} rel="noreferrer">
                {record.name}
              </a>
            ) : (
              record.name
            )}
            {record.attribution && <p>{record.attribution}</p>}
            {record.licence && (
              <p>
                {m.candidate_licence({}, options)}:{' '}
                {record.licence.url && webUrl(record.licence.url) ? (
                  <a className="underline" href={record.licence.url} rel="noreferrer">
                    {record.licence.id}
                  </a>
                ) : (
                  record.licence.id
                )}
              </p>
            )}
          </div>
        ))}
    </div>
  );
}
