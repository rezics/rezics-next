import { useCandidateWork, type CandidateWork } from '../../subject/candidate-lifetime';
import { useEffect, useReducer, useRef, useState, type ComponentProps } from 'react';
import { RichTextEditor } from '@rezics/ui';
import { DocumentBody } from '../../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import type { Violation } from '@rezics/definitions/validate';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { editorLabels } from '../../threads/composer';
import { CandidateValue, pageText } from '../pages/data';
import { SpoilerGate } from '../pages/values';
import { spoilerLevel } from '../pages/shared';
import { EditorFailure } from './statement-editor-view';
import { authoredState, initialAuthoredState, type AuthoredDraft } from './authored-field-state';
import {
  authoredProperties,
  authoredStatement,
  validateAuthored,
  type AuthoredBody,
  type AuthoredRead,
  type AuthoredTransport,
} from './authored-field';

// Match the caller-level phone targets while retaining dense fine-pointer desktop controls.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
// NativeSelect puts className on the wrapper, so size its actual native control as well.
const selectClassName = 'min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full whitespace-normal break-words';

function Body({ body, locale }: { body: AuthoredBody | null | undefined; locale: string }) {
  const o = { locale: locale as never };
  if (!body?.ok || body.document.availability !== 'available' || !body.document.body)
    return <p role="status">{m.authored_body_unavailable({}, o)}</p>;
  const document = body.document;
  return (
    <div className="space-y-3">
      <div lang={document.language}>
        <DocumentBody
          document={document.body!}
          locale={locale}
          labels={{ revealSpoiler: m.thread_reveal_spoiler({}, o) }}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {m.authored_language({}, o)}: {document.language}
      </p>
      <p className="text-sm text-muted-foreground">
        {m.authored_licence({}, o)}:{' '}
        {'origin' in document && document.origin === 'account'
          ? document.licence
          : 'rights' in document
            ? document.rights.license
            : ''}
      </p>
      {'rights' in document && <p className="text-sm text-muted-foreground">{document.rights.attribution}</p>}
    </div>
  );
}

/** Always composes a new original work; existing rich documents and candidates remain intact. */
export function AuthoredField(props: Omit<ComponentProps<typeof AuthoredFieldLive>, 'work'>) {
  const subject = useRef<string | undefined>(undefined);
  if (props.initial.ok) subject.current = props.initial.public.subject.id;
  const work = useCandidateWork(JSON.stringify([subject.current, props.locale]), props.transport.reader);
  if (!work.live()) return null;
  return <AuthoredFieldLive key={work.generation} {...props} work={work} />;
}

function AuthoredFieldLive({
  initial,
  locale,
  transport,
  confirm,
  work,
}: {
  work: CandidateWork;
  initial: AuthoredRead;
  locale: string;
  transport: AuthoredTransport;
  confirm: CandidateTransport['confirm'];
}) {
  const o = { locale: locale as never };
  const [metadata, setMetadata] = useState(initial);
  const [current, setCurrent] = useState(initial.ok ? initial : undefined);
  const [{ drafts, command, proposed, failure: submissionFailure }, dispatch] = useReducer(
    authoredState,
    initial,
    initialAuthoredState,
  );
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailure, setReadFailure] = useState(initial.ok ? undefined : initial.reason);
  const [errors, setErrors] = useState<Violation[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [proposalBody, setProposalBody] = useState<AuthoredBody | null>();
  const running = useRef(false);
  const session = useRef(initial.ok ? initial.session : undefined);
  const requestedProperty = useRef(initial.ok ? initial.property : '');
  useEffect(() => {
    if (work.live() && initial.ok) session.current = initial.session ?? session.current;
  }, [initial]);
  // A metadata refresh replaces read authority without remounting or discarding the submission state.
  if (metadata !== initial) {
    setMetadata(initial);
    setCurrent(initial.ok ? initial : undefined);
    setReadFailure(initial.ok ? undefined : initial.reason);
    dispatch({ type: 'read', read: initial, reviewDraft: false });
  }
  const property = current?.property ?? requestedProperty.current;
  const draft = drafts[property];
  const failure = submissionFailure ?? (!current ? 'unavailable' : undefined);
  const proposalSelected =
    !!proposed &&
    !busy &&
    !failure &&
    current?.public.subject.statements[property]?.some(
      (statement) =>
        statement.id === proposed.candidate &&
        statement.property.id === property &&
        (statement.rank === 'normal' || statement.rank === 'preferred'),
    );
  const locked = busy || !!command || !!proposed || !current || failure === 'denied';
  const title = current ? pageText(current.public.subject.labels, locale).text : '';
  const id = current?.public.subject.id;
  const update = (change: Partial<AuthoredDraft>) => {
    if (!work.live() || locked || running.current || !draft) return;
    dispatch({ type: 'edit', property, change });
    setErrors([]);
  };

  async function refresh(
    nextProperty = property,
    reviewDraft = false,
    readingOnly = false,
    origin: CandidateWork = work,
  ) {
    if (!work.live() || !origin.live() || running.current || (command && !reviewDraft)) return;
    requestedProperty.current = nextProperty;
    running.current = true;
    setBusy(true);
    setReading(true);
    if (!readingOnly) setProposalBody(undefined);
    try {
      // Decision recovery refreshes both authorities. The current-text action reads only the
      // public text and leaves an independently authorized comparison intact while it remains readable.
      const comparison =
        !readingOnly && proposed && reviewing && nextProperty === property
          ? await transport.review(property, proposed.candidate, undefined, session.current, origin)
          : undefined;
      if (!work.live() || !origin.live()) return;
      const next: AuthoredRead = comparison
        ? (comparison.current ??
          (comparison.comparison.ok ? { ok: false, reason: 'unavailable' } : comparison.comparison))
        : await transport.read(nextProperty || undefined, session.current);
      if (!work.live() || !origin.live()) return;
      if (comparison) {
        setProposalBody(comparison.body);
        if (comparison.comparison.ok) session.current = comparison.comparison.session ?? session.current;
      }
      dispatch({ type: 'read', read: next, reviewDraft });
      setReadFailure(next.ok ? undefined : next.reason);
      if (!next.ok) {
        setCurrent(undefined);
        setProposalBody(undefined);
        setReviewing(false);
      } else {
        setCurrent(next);
        session.current = next.session ?? session.current;
      }
    } catch {
      if (!work.live() || !origin.live()) return;
      setCurrent(undefined);
      setProposalBody(undefined);
      setReviewing(false);
      setReadFailure('unavailable');
      dispatch({ type: 'read', read: { ok: false, reason: 'unavailable' }, reviewDraft });
    } finally {
      if (!work.live() || !origin.live()) return;
      running.current = false;
      setBusy(false);
      setReading(false);
    }
  }

  async function rereadAfterDenial(origin: CandidateWork = work) {
    if (!work.live() || !origin.live()) return;
    // A write denial clears private comparison data. Only a fresh public read may restore selected text.
    setCurrent(undefined);
    setProposalBody(undefined);
    setReviewing(false);
    try {
      const next = await transport.read(property || undefined, session.current);
      if (!work.live() || !origin.live()) return;
      if (next.ok) {
        session.current = next.session ?? session.current;
        setCurrent(next);
      }
    } catch {
      // Keep the unavailable read empty; neither the draft nor the previous body is a fallback.
    }
  }

  async function submit() {
    if (
      !work.live() ||
      running.current ||
      proposed ||
      !current ||
      !draft ||
      failure === 'stale' ||
      failure === 'denied'
    )
      return;
    let request = command;
    if (!request) {
      const statement = authoredStatement(property, draft.document, draft.language, draft.licence, draft.citation);
      const violations = validateAuthored(statement, current.release);
      if (!draft.original) violations.push({ pointer: '/original', code: 'required' });
      setErrors(violations);
      if (violations.length) return;
      request = {
        id: current.public.subject.id,
        key: crypto.randomUUID(),
        statement: structuredClone(statement),
        ...(session.current ? { session: session.current } : {}),
      };
    }
    running.current = true;
    setBusy(true);
    setReadFailure(undefined);
    dispatch({ type: 'submit', command: request });
    try {
      const result = await transport.propose(request);
      if (!work.live()) return;
      dispatch({ type: 'result', result });
      if (result.ok) {
        session.current = result.session ?? session.current;
      } else {
        if (result.reason === 'denied') await rereadAfterDenial();
      }
    } catch {
      if (!work.live()) return;
      dispatch({ type: 'result', result: { ok: false, reason: 'unavailable' } });
    } finally {
      if (!work.live()) return;
      running.current = false;
      setBusy(false);
    }
  }

  const errorField = (error: Violation) =>
    error.pointer === '/original'
      ? 'original'
      : error.pointer.includes('/language')
        ? 'language'
        : error.pointer.includes('/licence')
          ? 'licence'
          : error.pointer.includes('/references')
            ? 'citation'
            : 'document';
  const labels = {
    original: m.authored_original({}, o),
    language: m.authored_language({}, o),
    licence: m.authored_licence({}, o),
    citation: m.authored_citation({}, o),
    document: m.authored_text({}, o),
  };
  const review: CandidateTransport = {
    reader: work.reader,
    read: async (field, cursor, continuity, origin = work) => {
      if (!work.live() || !origin.live()) return { ok: false, reason: 'denied' };
      if (!proposed || !id || field !== property) return { ok: false, reason: 'invalid' };
      setProposalBody(undefined);
      const result = await transport.review(
        property,
        proposed.candidate,
        cursor,
        continuity ?? session.current,
        origin,
      );
      if (!work.live() || !origin.live()) return { ok: false, reason: 'denied' };
      if (result.comparison.ok) session.current = result.comparison.session ?? session.current;
      if (result.current) setCurrent(result.current);
      setProposalBody(result.body);
      return result.comparison;
    },
    confirm: async (input, origin = work) => {
      if (!work.live() || !origin.live()) return { ok: false, reason: 'denied' };
      const result = await confirm(input, origin);
      if (!work.live() || !origin.live()) return result;
      setProposalBody(undefined);
      if (result.ok) {
        session.current = result.session ?? session.current;
        // Read the actual public statement and its authorized body, never the submission or decision receipt.
        await refresh(property, false, false, origin);
      } else if (result.reason === 'denied') {
        dispatch({ type: 'denied' });
        await rereadAfterDenial(origin);
      }
      return result;
    },
  };
  const selectedContent = current?.selected && (
    <>
      <Body body={current.body} locale={locale} />
      <details>
        <summary className="cursor-pointer text-sm">{m.authored_current_citations({}, o)}</summary>
        <div className="space-y-2 py-2">
          {current.selected.references.length ? (
            current.selected.references.map((reference, index) => (
              <div key={index}>
                {reference.parts.map((part, index) => (
                  <CandidateValue key={index} snak={part} related={current.public.related} locale={locale} />
                ))}
              </div>
            ))
          ) : (
            <p>{m.authored_no_citations({}, o)}</p>
          )}
        </div>
      </details>
    </>
  );

  return (
    <article className="mx-auto min-w-0 w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.authored_title({}, o)}</h1>
        {current && (
          <p>
            <a
              className="text-primary underline-offset-4 hover:underline"
              href={subjectHref({ id: current.public.subject.id, label: title }, locale).href}
            >
              {title || m.subject_value_unlabelled({}, o)}
            </a>
            <span className="ml-3 text-sm text-muted-foreground">
              {pageText(current.release.types[current.public.subject.type]?.labels, locale).text}
            </span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{m.authored_intro({}, o)}</p>
      </header>
      {failure && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          {readFailure && !command ? (
            <p role="alert">
              {readFailure === 'denied'
                ? m.catalogue_result_read_denied({}, o)
                : m.catalogue_result_read_unavailable({}, o)}
            </p>
          ) : (
            <EditorFailure reason={failure} locale={locale} />
          )}
          <Button
            variant="outline"
            className={actionClassName}
            disabled={busy}
            onClick={() =>
              void (command && failure === 'unavailable'
                ? submit()
                : refresh(property, failure === 'stale', !!readFailure))
            }
          >
            {command && failure === 'unavailable'
              ? m.correction_retry({}, o)
              : readFailure && !command
                ? m.catalogue_retry_loading_result({}, o)
                : failure === 'stale'
                  ? m.authored_review_draft({}, o)
                  : m.correction_reload({}, o)}
          </Button>
        </div>
      )}
      {busy && <p role="status">{reading ? m.candidate_loading({}, o) : m.correction_saving({}, o)}</p>}
      {proposed && !current && <p role="status">{m.authored_submitted({}, o)}</p>}
      {current && !property && <p>{m.authored_empty({}, o)}</p>}
      {current && property && (
        <>
          <Field>
            <FieldLabel htmlFor="authored-property" className={labelClassName}>
              {m.candidate_field({}, o)}
            </FieldLabel>
            <NativeSelect
              id="authored-property"
              className={selectClassName}
              value={property}
              disabled={locked}
              onChange={(event) => void refresh(event.target.value)}
            >
              {authoredProperties(current.release, current.public.subject.type).map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {pageText(current.release.properties[id]!.labels, locale).text}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <section className="space-y-3 rounded-xl bg-muted/30 p-4" aria-label={m.authored_selected({}, o)}>
            <h2 className="text-lg font-semibold">{m.authored_selected({}, o)}</h2>
            {current.selected ? (
              spoilerLevel(current.selected) > 0 ? (
                <SpoilerGate label={m.thread_reveal_spoiler({}, o)}>{selectedContent}</SpoilerGate>
              ) : (
                selectedContent
              )
            ) : (
              <p>{m.authored_no_selected({}, o)}</p>
            )}
            <Button
              variant="outline"
              className={actionClassName}
              disabled={busy || !!command}
              onClick={() => void refresh(property, false, true)}
            >
              {m.authored_reload_current_text({}, o)}
            </Button>
          </section>
        </>
      )}
      {(current || command) && property && (
        <>
          {draft && failure !== 'denied' && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h2 className="text-lg font-semibold">{m.authored_replacement({}, o)}</h2>
              <p className="text-sm text-muted-foreground">{m.authored_preserved({}, o)}</p>
              {errors.length > 0 && (
                <div role="alert" className="space-y-2">
                  <p>{m.authored_invalid({}, o)}</p>
                  <ul>
                    {[...new Set(errors.map(errorField))].map((field) => (
                      <li key={field}>
                        <a className="text-primary underline" href={`#authored-${field}`}>
                          {labels[field]}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div id="authored-document">
                <RichTextEditor
                  value={draft.document}
                  label={labels.document}
                  labels={editorLabels()}
                  disabled={locked}
                  onChange={(document) => update({ document })}
                  {...(draft.language ? { lang: draft.language } : {})}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="authored-language" className={labelClassName}>
                    {labels.language}
                  </FieldLabel>
                  <Input
                    id="authored-language"
                    className={inputClassName}
                    value={draft.language}
                    maxLength={128}
                    disabled={locked}
                    aria-invalid={errors.some((error) => errorField(error) === 'language')}
                    placeholder="en"
                    onChange={(event) => update({ language: event.target.value })}
                  />
                  <p className="text-sm text-muted-foreground">{m.authored_language_hint({}, o)}</p>
                </Field>
                <Field>
                  <FieldLabel htmlFor="authored-licence" className={labelClassName}>
                    {labels.licence}
                  </FieldLabel>
                  <Input
                    id="authored-licence"
                    className={inputClassName}
                    value={draft.licence}
                    maxLength={128}
                    disabled={locked}
                    aria-invalid={errors.some((error) => errorField(error) === 'licence')}
                    placeholder="CC-BY-4.0"
                    onChange={(event) => update({ licence: event.target.value })}
                  />
                  <p className="text-sm text-muted-foreground">{m.authored_licence_hint({}, o)}</p>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="authored-citation" className={labelClassName}>
                  {labels.citation}
                </FieldLabel>
                <Input
                  id="authored-citation"
                  className={inputClassName}
                  type="url"
                  value={draft.citation}
                  disabled={locked}
                  aria-invalid={errors.some((error) => errorField(error) === 'citation')}
                  onChange={(event) => update({ citation: event.target.value })}
                />
                <p className="text-sm text-muted-foreground">{m.authored_citation_hint({}, o)}</p>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="authored-original"
                  checked={draft.original}
                  disabled={locked}
                  onCheckedChange={(checked) => update({ original: checked === true })}
                />
                <FieldLabel
                  htmlFor="authored-original"
                  className="min-h-11 min-w-0 max-w-full whitespace-normal break-words md:pointer-fine:min-h-0"
                >
                  {labels.original}
                </FieldLabel>
              </Field>
              <p role="status" className="text-sm text-muted-foreground">
                {proposed
                  ? proposalSelected
                    ? m.candidate_selected({}, o)
                    : m.authored_submitted({}, o)
                  : m.authored_draft({}, o)}
              </p>
              {!proposed && (
                <Button
                  type="submit"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                  disabled={locked}
                >
                  {m.correction_submit({}, o)}
                </Button>
              )}
            </form>
          )}
          {proposed && id && current && (
            <section className="space-y-4">
              {!reviewing ? (
                <Button variant="outline" className={actionClassName} onClick={() => work.live() && setReviewing(true)}>
                  {m.correction_review({}, o)}
                </Button>
              ) : (
                <>
                  {proposalBody !== undefined && (
                    <section
                      aria-label={m.authored_candidate({}, o)}
                      className="space-y-3 rounded-xl border border-border p-4"
                    >
                      <h2 className="text-lg font-semibold">{m.authored_candidate({}, o)}</h2>
                      <p className="text-sm text-muted-foreground">{m.authored_candidate_hint({}, o)}</p>
                      <Body body={proposalBody} locale={locale} />
                    </section>
                  )}
                  <CandidateReview
                    id={id}
                    locale={locale}
                    transport={review}
                    initialProperty={property}
                    exactCandidate={proposed.candidate}
                    documents={{
                      public: current.body?.ok ? { [current.body.document.candidateId]: current.body.document } : {},
                      candidates: {
                        ...(current.body?.ok ? { [current.body.document.candidateId]: current.body.document } : {}),
                        ...(proposalBody?.ok ? { [proposalBody.document.candidateId]: proposalBody.document } : {}),
                      },
                    }}
                  />
                </>
              )}
            </section>
          )}
        </>
      )}
    </article>
  );
}
