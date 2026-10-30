import { useMemo, useRef, useState } from 'react';
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

type ReviewAddress = { property: string; candidate: string; session?: string | undefined };
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
    <section className="space-y-3 rounded-lg bg-muted/30 p-4">
      <h4 className="text-sm font-medium">{m.candidate_current({}, o)}</h4>
      {!selected.length && <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>}
      {selected.map((statement) => (
        <div key={statement.id} className="space-y-2">
          <PartValue part={statement} read={read} locale={locale} />
          {statement.qualifiers.map((part, index) => (
            <div key={index} className="text-sm">
              <span className="text-muted-foreground">
                {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
                  m.subject_value_unlabelled({}, o)}
                :{' '}
              </span>
              <PartValue part={part} read={read} locale={locale} />
            </div>
          ))}
          {statement.references.map((reference, index) => (
            <div key={index} className="border-s-2 border-border ps-3 text-sm">
              <p className="text-muted-foreground">
                {m.correction_references({}, o)} {index + 1}
              </p>
              {reference.parts.map((part, partIndex) => (
                <div key={partIndex}>
                  <PartValue part={part} read={read} locale={locale} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </section>
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
  href,
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
  href: string;
  onReview: (address: ReviewAddress) => void;
}) {
  const o = { locale: locale as never };
  const definition = read.release.properties[property]!;
  const label = pageText(definition.labels, locale).text || m.subject_value_unlabelled({}, o);
  const selected = read.public.subject.statements[property] ?? [];
  const [source, setSource] = useState(selected.length === 1 ? selected[0]!.id : '');
  const sourceIndex = draft?.source ? selected.findIndex((item) => item.id === draft.source) : -1;
  const locked = !!draft && factLocked(draft);
  return (
    <section aria-label={label} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-lg font-semibold">{label}</h3>
      <p className="text-sm text-muted-foreground">
        {definition.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
      </p>
      <SelectedFacts property={property} read={read} locale={locale} />
      {!draft ? (
        <div className="flex flex-wrap items-end gap-3">
          {!!selected.length && (
            <Field className="min-w-0 flex-1">
              <FieldLabel>{m.facts_choose_value({}, o)}</FieldLabel>
              <NativeSelect
                aria-label={m.facts_choose_value({}, o)}
                value={source}
                onChange={(event) => setSource(event.target.value)}
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
          <Button
            type="button"
            variant="outline"
            disabled={busy || !canStage || (!!selected.length && !source)}
            onClick={() => onStage(source || null)}
          >
            {m.facts_edit_field({}, o)}
          </Button>
          {!!selected.length && definition.multivalued && (
            <Button type="button" variant="outline" disabled={busy || !canStage} onClick={() => onStage(null)}>
              {m.facts_add_value({}, o)}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm font-medium">
            {m.facts_private({}, o)}
            {draft.source && (
              <>
                {' '}
                ·{' '}
                {sourceIndex >= 0 ? m.facts_selected_value({ number: sourceIndex + 1 }, o) : m.correction_stale({}, o)}
              </>
            )}
          </p>
          {!draft.result?.ok && (
            <fieldset disabled={busy || locked} className="space-y-5">
              <StatementFields
                heading="h4"
                draft={draft.statement}
                current={{ ...read, source: selected.find((item) => item.id === draft.source) ?? null }}
                locale={locale}
                change={(statement) => onChange({ ...draft, statement, command: undefined, result: undefined })}
                guideReturn={`${href}/edit`}
              />
            </fieldset>
          )}
          {!draft.result?.ok && (
            <Field orientation="horizontal">
              <Checkbox
                id={`include-${property}`}
                checked={draft.included}
                disabled={busy || locked}
                onCheckedChange={(included) => onChange({ ...draft, included: included === true })}
              />
              <FieldLabel htmlFor={`include-${property}`}>{m.facts_include({}, o)}</FieldLabel>
            </Field>
          )}
          {!factChanged(draft) && <p className="text-sm text-muted-foreground">{m.facts_unchanged({}, o)}</p>}
          {draft.result && (
            <div className="space-y-3" role="status">
              {draft.result.ok ? (
                <>
                  <p>{m.correction_proposed({}, o)}</p>
                  <a
                    href={`${href}/edit?${new URLSearchParams({ reviewProperty: property, candidate: draft.result.candidate })}`}
                    className={buttonVariants({ variant: 'outline' })}
                    onClick={(event) => {
                      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function SubjectFacts({
  initial,
  locale,
  transport,
  review,
  initialReview,
}: {
  initial: EditorRead;
  locale: string;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  initialReview?: ReviewAddress | undefined;
}) {
  const o = { locale: locale as never };
  const [read, setRead] = useState(initial);
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(initialReview);
  const running = useRef(false);
  const current = read.ok ? read : null;
  const subject = current?.public.subject;
  const label = pageText(subject?.labels, locale).text || m.subject_value_unlabelled({}, o);
  const href = subject ? subjectHref({ id: subject.id, label }, locale).href : '';
  const groups = current ? factGroups(current) : { text: [], time: [], quantity: [] };
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  const success = drafts.filter((draft) => draft.result?.ok).length;
  function change(next: FactDraft) {
    setDrafts((previous) => previous.map((item) => (item.property === next.property ? next : item)));
  }
  async function submit() {
    if (!current || running.current || !changed.length) return;
    running.current = true;
    const sealed = sealFacts(current.public.subject.id, current.release, drafts);
    setDrafts(sealed);
    setBusy(true);
    try {
      await sendFacts(sealed, transport.propose, (property, result) =>
        setDrafts((previous) => previous.map((draft) => (draft.property === property ? { ...draft, result } : draft))),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      setRead(await transport.read());
    } catch {
      setRead({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const groupLabels = { text: m.facts_text({}, o), time: m.facts_dates({}, o), quantity: m.facts_quantities({}, o) };
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6" aria-busy={busy}>
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{m.facts_title({}, o)}</h1>
        {subject && (
          <p>
            <a href={href} className="underline underline-offset-4">
              {label}
            </a>
            <span className="ms-2 text-muted-foreground">
              {pageText(current?.release.types[subject.type]?.labels, locale).text}
            </span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{m.facts_intro({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.correction_global({}, o)}</p>
        {subject && <DefinitionGuideLink locale={locale} address={{ type: subject.type, returnTo: `${href}/edit` }} />}
      </header>
      {!read.ok && <EditorFailure reason={read.reason} locale={locale} />}
      {current && (
        <>
          <nav aria-label={m.facts_other_editors({}, o)} className="flex flex-wrap gap-3">
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
          {!Object.values(groups).some((properties) => properties.length) && <p>{m.facts_empty({}, o)}</p>}
          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {Object.entries(groups)
              .filter(([, properties]) => properties.length)
              .map(([group, properties]) => (
                <section key={group} className="space-y-4">
                  <h2 className="text-xl font-semibold">{groupLabels[group as keyof typeof groupLabels]}</h2>
                  {properties.map((property) => (
                    <FactField
                      key={property}
                      property={property}
                      read={current}
                      locale={locale}
                      href={href}
                      busy={busy}
                      canStage={drafts.length < factLimit}
                      draft={drafts.find((draft) => draft.property === property)}
                      onChange={change}
                      onReview={setReviewing}
                      onStage={(source) => {
                        const draft = stageFact(current, property, source);
                        if (draft)
                          setDrafts((previous) => (previous.length < factLimit ? [...previous, draft] : previous));
                      }}
                    />
                  ))}
                </section>
              ))}
            <div className="space-y-3 rounded-xl border border-border bg-card p-4">
              <p>{m.facts_selection({ count: changed.length, limit: factLimit }, o)}</p>
              <p className="text-sm text-muted-foreground">{m.facts_separate_results({}, o)}</p>
              {!!success && <p role="status">{m.facts_results({ count: success }, o)}</p>}
              {busy && <p role="status">{m.correction_saving({}, o)}</p>}
              <Button type="submit" disabled={busy || !changed.length}>
                {m.facts_submit({}, o)}
              </Button>
            </div>
          </form>
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
      <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
        {m.correction_reload({}, o)}
      </Button>
    </article>
  );
}
