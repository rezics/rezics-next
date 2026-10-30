import { useRef, useState } from 'react';
import { CandidateValue, pageText } from '../features/pages/data';
import { webUrl } from '../features/pages/shared';
import { m } from '../paraglide/messages.js';
import { subjectHref } from './subject-href';
import {
  candidateIsPublic,
  candidateSourceRecords,
  type Candidate,
  type CandidateCommand,
  type CandidateFailure,
  type CandidateRead,
  type CandidateResult,
} from './candidates';

export type CandidateTransport = {
  read: (property?: string, cursor?: string) => Promise<CandidateRead>;
  confirm: (command: CandidateCommand) => Promise<CandidateResult>;
};
const button =
  'min-h-11 rounded-lg border border-border bg-background px-4 py-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

/** A session-only region: the owning subject route mounts it only after sign-in hydration. */
export function CandidateReview({
  id,
  locale,
  transport,
  initialProperty,
  exactCandidate,
}: {
  id: string;
  locale: string;
  transport: CandidateTransport;
  initialProperty?: string | undefined;
  exactCandidate?: string;
}) {
  const options = { locale: locale as never };
  const [opened, setOpened] = useState(false);
  const [read, setRead] = useState<CandidateRead>();
  const [property, setProperty] = useState(initialProperty ?? '');
  const [candidate, setCandidate] = useState<Candidate>();
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CandidateFailure>();
  const [result, setResult] = useState<CandidateResult & { ok: true }>();
  const request = useRef<CandidateCommand | null>(null);
  const running = useRef(false);
  const current = read?.ok ? read : undefined;
  const publicRead = result?.public ?? current?.public;
  const selected = !!candidate && !!publicRead && candidateIsPublic(publicRead, property, candidate.id);
  const operation = candidate?.decision === 'accepted' ? 'adopt' : 'accept';
  const action = operation === 'accept' ? m.candidate_accept({}, options) : m.candidate_adopt({}, options);

  async function load(field = property, cursor?: string) {
    if (running.current) return;
    running.current = true;
    setOpened(true);
    setBusy(true);
    setFailure(undefined);
    setConfirmation(false);
    setCandidate(undefined);
    setResult(undefined);
    request.current = null;
    try {
      const next = await transport.read(field || undefined, cursor);
      setRead(next);
      if (next.ok && exactCandidate)
        setCandidate(next.page?.candidates.find((item) => item.id === exactCandidate && item.retracted === null));
      if (!next.ok) setFailure(next);
    } catch {
      setRead(undefined);
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  async function confirm() {
    if (!candidate || !current?.page || running.current || selected) return;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    request.current ??= {
      id,
      property,
      candidate: candidate.id,
      operation,
      head: operation === 'accept' ? candidate.head : (current.page.adoption?.head ?? null),
      key: crypto.randomUUID(),
    };
    try {
      const next = await transport.confirm(request.current);
      if (!next.ok) {
        setFailure(next);
        // Keep the exact request on an uncertain outcome so Retry uses the native receipt.
        if (next.reason !== 'unavailable') {
          setConfirmation(false);
          request.current = null;
        }
        if (next.reason === 'denied') {
          setRead(undefined);
          setCandidate(undefined);
        }
      } else {
        setResult(next);
        setConfirmation(false);
        request.current = null;
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  return (
    <section
      id="candidate-review"
      aria-label={m.candidate_title({}, options)}
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <div className="space-y-1">
        <h2 className="font-serif text-xl font-semibold">{m.candidate_title({}, options)}</h2>
        <p className="text-sm text-muted-foreground">{m.candidate_intro({}, options)}</p>
      </div>
      {!opened ? (
        <button type="button" className={button} onClick={() => load()}>
          {m.candidate_entry({}, options)}
        </button>
      ) : (
        <>
          {busy && <p role="status">{m.candidate_loading({}, options)}</p>}
          {failure && (
            <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-3">
              <p>
                {failure.reason === 'stale'
                  ? m.candidate_stale({}, options)
                  : failure.reason === 'denied'
                    ? m.candidate_denied({}, options)
                    : failure.reason === 'invalid'
                      ? m.candidate_invalid({}, options)
                      : m.candidate_unavailable({}, options)}
              </p>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => (confirmation && request.current ? confirm() : load())}
              >
                {confirmation && request.current ? m.candidate_retry({}, options) : m.candidate_reload({}, options)}
              </button>
            </div>
          )}
          {result && (
            <div role="status" className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
              <p>
                {result.kind === 'selected'
                  ? m.candidate_selected({}, options)
                  : result.kind === 'accepted'
                    ? m.candidate_accepted({}, options)
                    : m.candidate_pending({}, options)}
              </p>
              {result.kind === 'selected' && result.public && (
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
              <button type="button" className={button} disabled={busy} onClick={() => load()}>
                {m.candidate_reload({}, options)}
              </button>
            </div>
          )}
          {current && (
            <>
              <label className="block space-y-2 text-sm font-medium">
                <span>{m.candidate_field({}, options)}</span>
                <select
                  className={`${button} block w-full`}
                  value={property}
                  disabled={busy || confirmation || !!exactCandidate}
                  onChange={(event) => {
                    setProperty(event.target.value);
                    void load(event.target.value);
                  }}
                >
                  <option value="">{m.candidate_choose_field({}, options)}</option>
                  {current.fields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </label>
              {current.page && !candidate && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{m.candidate_list_hint({}, options)}</p>
                  {(!current.page.candidates.length ||
                    (exactCandidate && !current.page.candidates.some((item) => item.id === exactCandidate))) && (
                    <p>{exactCandidate ? m.correction_exact_missing({}, options) : m.candidate_empty({}, options)}</p>
                  )}
                  <ul className="space-y-3">
                    {current.page.candidates
                      .filter((item) => !exactCandidate || item.id === exactCandidate)
                      .map((item) => (
                        <li key={item.id} className="space-y-3 rounded-lg border border-border p-3">
                          <CandidateValue snak={item.statement} related={current.public.related} locale={locale} />
                          <CandidateProvenance candidate={item} read={current} locale={locale} />
                          <button
                            type="button"
                            className={button}
                            disabled={busy || item.retracted !== null}
                            onClick={() => {
                              setCandidate(item);
                              setResult(undefined);
                              setFailure(undefined);
                              request.current = null;
                            }}
                          >
                            {item.retracted !== null
                              ? m.candidate_retracted({}, options)
                              : m.candidate_review({}, options)}
                          </button>
                        </li>
                      ))}
                  </ul>
                  {current.page.next && (
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => load(property, current.page!.next!)}
                    >
                      {m.candidate_more({}, options)}
                    </button>
                  )}
                </div>
              )}
              {candidate && (
                <div className="space-y-4">
                  <h3 className="font-semibold">{current.fields.find((field) => field.id === property)?.label}</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-3">
                      <h4 className="text-sm font-semibold">{m.candidate_current({}, options)}</h4>
                      {publicRead?.subject.statements[property]?.length ? (
                        publicRead.subject.statements[property]!.map((statement) => (
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
                      <CandidateValue snak={candidate.statement} related={current.public.related} locale={locale} />
                      {candidate.statement.qualifiers.map((snak, index) => (
                        <p key={index}>
                          <span className="text-sm text-muted-foreground">
                            {pageText(current.names[snak.property.id], locale).text ||
                              m.subject_value_unlabelled({}, options)}
                            :{' '}
                          </span>
                          <CandidateValue snak={snak} related={current.public.related} locale={locale} />
                        </p>
                      ))}
                      <CandidateProvenance candidate={candidate} read={current} locale={locale} />
                    </div>
                  </div>
                  {selected ? (
                    <p>{m.candidate_selected({}, options)}</p>
                  ) : result ? null : confirmation ? (
                    <div className="space-y-3 rounded-lg border border-border p-4">
                      <h4 className="font-semibold">{m.candidate_confirm_title({ action }, options)}</h4>
                      <p className="text-sm">
                        {operation === 'accept'
                          ? m.candidate_confirm_accept({}, options)
                          : m.candidate_confirm_adopt({}, options)}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={button}
                          disabled={busy || (!!failure && failure.reason !== 'unavailable')}
                          onClick={confirm}
                        >
                          {action}
                        </button>
                        <button
                          type="button"
                          className={button}
                          disabled={busy || !!request.current}
                          onClick={() => setConfirmation(false)}
                        >
                          {m.candidate_cancel({}, options)}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={button}
                      disabled={busy || failure?.reason === 'stale'}
                      onClick={() => setConfirmation(true)}
                    >
                      {action}
                    </button>
                  )}
                  <button
                    type="button"
                    className={button}
                    disabled={busy || confirmation}
                    onClick={() => {
                      setCandidate(undefined);
                      setResult(undefined);
                    }}
                  >
                    {m.candidate_back({}, options)}
                  </button>
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className={button}
            disabled={busy || confirmation}
            onClick={() => {
              setOpened(false);
              setRead(undefined);
              setCandidate(undefined);
              setResult(undefined);
              setFailure(undefined);
              setProperty(initialProperty ?? '');
              request.current = null;
            }}
          >
            {m.candidate_close({}, options)}
          </button>
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
