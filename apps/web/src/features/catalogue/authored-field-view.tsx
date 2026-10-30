import { useRef, useState } from 'react';
import { RichTextEditor } from '@rezics/ui';
import { DocumentBody } from '@rezics/ui/document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Violation } from '@rezics/definitions/validate';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { editorLabels } from '../../threads/composer';
import { CandidateValue, pageText } from '../pages/data';
import { SpoilerGate } from '../pages/values';
import { spoilerLevel } from '../pages/shared';
import { EditorFailure } from './statement-editor-view';
import type { ProposalResult } from './statement-editor';
import {
  authoredProperties,
  authoredStatement,
  validateAuthored,
  type AuthoredBody,
  type AuthoredCommand,
  type AuthoredRead,
  type AuthoredTransport,
} from './authored-field';

type Draft = { document: DocumentSnapshot; language: string; licence: string; citation: string; original: boolean };
const blank = (): Draft => ({ document: fromPlainText(''), language: '', licence: '', citation: '', original: false });

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
export function AuthoredField({
  initial,
  locale,
  transport,
  confirm,
}: {
  initial: AuthoredRead;
  locale: string;
  transport: AuthoredTransport;
  confirm: CandidateTransport['confirm'];
}) {
  const o = { locale: locale as never };
  const [current, setCurrent] = useState(initial.ok ? initial : undefined);
  const [failure, setFailure] = useState(initial.ok ? undefined : initial.reason);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    initial.ok ? { [initial.property]: blank() } : {},
  );
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Violation[]>([]);
  const [proposed, setProposed] = useState<Extract<ProposalResult, { ok: true }>>();
  const [reviewing, setReviewing] = useState(false);
  const [proposalBody, setProposalBody] = useState<AuthoredBody | null>();
  const command = useRef<AuthoredCommand | null>(null);
  const running = useRef(false);
  const session = useRef(initial.ok ? initial.session : undefined);
  const requestedProperty = useRef(initial.ok ? initial.property : '');
  const property = current?.property ?? requestedProperty.current;
  const draft = drafts[property];
  const locked = busy || !!command.current || !!proposed || !current;
  const title = current ? pageText(current.public.subject.labels, locale).text : '';
  const id = current?.public.subject.id;
  const update = (change: Partial<Draft>) => {
    if (locked || !draft) return;
    setDrafts((previous) => ({ ...previous, [property]: { ...previous[property]!, ...change } }));
    setErrors([]);
    setFailure(undefined);
  };

  async function refresh(nextProperty = property, reviewDraft = false) {
    if (running.current || (command.current && !reviewDraft)) return;
    requestedProperty.current = nextProperty;
    running.current = true;
    setBusy(true);
    setProposalBody(undefined);
    try {
      const next = await transport.read(nextProperty || undefined, session.current);
      if (!next.ok) {
        setFailure(next.reason);
        setCurrent(undefined);
      } else {
        setCurrent(next);
        session.current = next.session ?? session.current;
        setDrafts((previous) => (previous[next.property] ? previous : { ...previous, [next.property]: blank() }));
        setFailure(undefined);
        if (reviewDraft) command.current = null;
      }
    } catch {
      setCurrent(undefined);
      setFailure('unavailable');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function submit() {
    if (running.current || proposed || !current || !draft || failure === 'stale') return;
    if (!command.current) {
      const statement = authoredStatement(property, draft.document, draft.language, draft.licence, draft.citation);
      const violations = validateAuthored(statement, current.release);
      if (!draft.original) violations.push({ pointer: '/original', code: 'required' });
      setErrors(violations);
      if (violations.length) return;
      command.current = {
        id: current.public.subject.id,
        key: crypto.randomUUID(),
        statement: structuredClone(statement),
        ...(session.current ? { session: session.current } : {}),
      };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.propose(command.current);
      if (result.ok) {
        session.current = result.session ?? session.current;
        setProposed(result);
        command.current = null;
      } else {
        setFailure(result.reason);
        if (result.reason !== 'unavailable' && result.reason !== 'stale') command.current = null;
        if (result.reason === 'denied') {
          setCurrent(undefined);
          setProposalBody(undefined);
        }
      }
    } catch {
      setFailure('unavailable');
    } finally {
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
    read: async (field, cursor) => {
      if (!proposed || !id || field !== property) return { ok: false, reason: 'invalid' };
      setProposalBody(undefined);
      const result = await transport.review(property, proposed.candidate, cursor, session.current);
      if (result.comparison.ok) session.current = result.comparison.session ?? session.current;
      setProposalBody(result.body);
      return result.comparison;
    },
    confirm: async (input) => {
      const result = await confirm({ ...input, ...(session.current ? { session: session.current } : {}) });
      setProposalBody(undefined);
      if (result.ok) {
        session.current = result.session ?? session.current;
        // Read the actual public statement and its authorized body, never the submission or decision receipt.
        await refresh();
      } else if (result.reason === 'denied') {
        setFailure('denied');
        setCurrent(undefined);
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
    <article className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
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
          <EditorFailure reason={failure} locale={locale} />
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void (command.current && failure === 'unavailable' ? submit() : refresh(property, failure === 'stale'))
            }
          >
            {command.current && failure === 'unavailable'
              ? m.correction_retry({}, o)
              : failure === 'stale'
                ? m.authored_review_draft({}, o)
                : m.correction_reload({}, o)}
          </Button>
        </div>
      )}
      {busy && <p role="status">{m.correction_saving({}, o)}</p>}
      {current && !property && <p>{m.authored_empty({}, o)}</p>}
      {current && property && (
        <>
          <Field>
            <FieldLabel htmlFor="authored-property">{m.candidate_field({}, o)}</FieldLabel>
            <NativeSelect
              id="authored-property"
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
            <Button variant="outline" disabled={busy || !!command.current} onClick={() => void refresh()}>
              {m.correction_reload({}, o)}
            </Button>
          </section>
          {draft && (
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
                  <FieldLabel htmlFor="authored-language">{labels.language}</FieldLabel>
                  <Input
                    id="authored-language"
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
                  <FieldLabel htmlFor="authored-licence">{labels.licence}</FieldLabel>
                  <Input
                    id="authored-licence"
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
                <FieldLabel htmlFor="authored-citation">{labels.citation}</FieldLabel>
                <Input
                  id="authored-citation"
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
                <FieldLabel htmlFor="authored-original">{labels.original}</FieldLabel>
              </Field>
              <p role="status" className="text-sm text-muted-foreground">
                {proposed ? m.correction_proposed({}, o) : m.authored_draft({}, o)}
              </p>
              {!proposed && (
                <Button type="submit" className="min-h-11" disabled={locked}>
                  {m.correction_submit({}, o)}
                </Button>
              )}
            </form>
          )}
          {proposed && id && (
            <section className="space-y-4">
              {!reviewing ? (
                <Button variant="outline" onClick={() => setReviewing(true)}>
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
