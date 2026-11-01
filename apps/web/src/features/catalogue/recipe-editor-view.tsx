import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { hasDocumentContent } from '@rezics/document';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { RichTextEditor } from '@rezics/ui/rich-text-editor';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId, useRef, useState } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { editorLabels } from '../../threads/composer';
import { PageHeading } from '../../shell/page-heading';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import type { CandidateSlot } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import { CandidateValue } from '../pages/data';
import { newAuthoredField, authoredFieldValue, type AuthoredField } from './authored-field';
import type { CreateFailure, CreateResult } from './create-subject';
import { recipeDraft, recipeTarget, type RecipeCommand, type RecipeTransport, type RecipeRead } from './recipe-editor';
import { statementInput, type ProposalCommand, type ProposalResult, type StatementInput } from './statement-editor';
import { EditorFailure, ScalarControl } from './statement-editor-view';

type Ready = Extract<RecipeRead, { ok: true }>;
const recipeActionClassName =
  'h-auto min-h-8 min-w-11 max-w-full whitespace-normal break-words py-1.5 max-md:min-h-11 pointer-coarse:min-h-11';
const recipeInputClassName = 'min-w-0 max-md:min-h-11 pointer-coarse:min-h-11';
type Row = {
  id: string;
  statement: StatementInput;
  original?: boolean;
  source?: NonNullable<Ready['public']>['subject']['statements'][string][number];
};
const newRow = (property: string): Row => ({
  id: crypto.randomUUID(),
  statement: {
    property: { id: property },
    value: { type: 'value', content: '' },
    qualifiers: [],
    references: [],
    rank: 'normal',
  },
});

export const RecipeEditor = catalogueEditor(RecipeEditorLive);

function RecipeEditorLive({
  id,
  locale,
  session,
  transport,
  search,
  review,
}: {
  id?: string;
  locale: string;
  session: string;
  transport: RecipeTransport;
  search: EntityPickerSearch;
  review?: (property: string, slot: CandidateSlot | undefined, session?: string) => CandidateTransport;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: ['recipe-editor', id, locale, lifetime.generation],
    queryFn: transport.load,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const read = query.data?.ok ? query.data : undefined;
  const termsId = useId();
  const nextTermId = useRef(1);
  const [terms, setTerms] = useState([{ id: 0, language: locale, label: '', description: '', aliases: '' }]);
  const [rows, setRows] = useState<Row[]>([]);
  const [property, setProperty] = useState('');
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<RecipeCommand | null>(null);
  const running = useRef(false);
  const locked = busy || !!pending.current;
  const name = (id: string) => pickText(read?.release.properties[id]?.labels ?? {}, locale).text;
  async function create() {
    if (!lifetime.active()) return;
    if (running.current || !read || created || session !== 'signed-in' || failure?.reason === 'conflict') return;
    if (!pending.current) {
      const draft = recipeDraft(
        read.release,
        locale,
        terms,
        rows.map((row) => row.statement),
      );
      if (
        rows.some(
          (row) =>
            read.release.properties[row.statement.property.id]?.datatype === 'document' &&
            (!row.original ||
              row.statement.value.type !== 'value' ||
              !hasDocumentContent((row.statement.value.content as AuthoredField).document)),
        )
      )
        draft.errors.push({ pointer: '/statements/schema:recipeInstructions', code: 'required' });
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      pending.current = { item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.create(pending.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        setCreated(result);
        pending.current = null;
      } else {
        setFailure(result);
        if (result.reason !== 'unavailable' && result.reason !== 'conflict') pending.current = null;
      }
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  const currentHref = read?.public
    ? subjectHref({ id: read.public.subject.id, label: pickText(read.public.subject.labels, locale).text }, locale).href
    : undefined;
  const Workspace = id ? 'div' : 'form';
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeading>{id ? m.recipe_edit({}, o) : m.recipe_title({}, o)}</PageHeading>
      {!id && (
        <a
          className={buttonVariants({ variant: 'outline', className: recipeActionClassName })}
          href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
        >
          {m.catalogue_create_search({}, o)}
        </a>
      )}
      {session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out' ? m.catalogue_create_signed_out({}, o) : m.candidate_loading({}, o)}
        </p>
      )}
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || (query.data && !query.data.ok)) && (
        <div className="space-y-3">
          {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
            <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
          ) : (
            <EditorFailure locale={locale} reason="unavailable" />
          )}
          <Button className={recipeActionClassName} type="button" onClick={() => void query.refetch()}>
            {m.correction_retry({}, o)}
          </Button>
        </div>
      )}
      {read && read.fields.length === 0 && <p role="status">{m.recipe_empty({}, o)}</p>}
      {created ? (
        <section className="space-y-4">
          <p role="status">{m.recipe_created({}, o)}</p>
          {created.reader.state === 'ready' ? (
            <a className={buttonVariants({ className: recipeActionClassName })} href={created.reader.href}>
              {m.candidate_view_public({}, o)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
              </p>
              <Button
                className={recipeActionClassName}
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!lifetime.active()) return;
                  if (running.current) return;
                  running.current = true;
                  setBusy(true);
                  try {
                    const reader = await transport.read(created.id);
                    if (!lifetime.active()) return;
                    setCreated({ ...created, reader });
                  } catch {
                    if (!lifetime.active()) return;
                    setCreated({ ...created, reader: { state: 'unavailable' } });
                  } finally {
                    if (!lifetime.active()) return;
                    setBusy(false);
                    running.current = false;
                  }
                }}
              >
                {m.correction_retry({}, o)}
              </Button>
            </>
          )}
        </section>
      ) : (
        read &&
        read.fields.length > 0 && (
          <Workspace
            className="flex min-w-0 flex-col gap-6"
            noValidate={!id}
            onSubmit={(event) => {
              if (id) return;
              event.preventDefault();
              void create();
            }}
          >
            {currentHref && (
              <a className="underline" href={currentHref}>
                {m.candidate_view_public({}, o)}
              </a>
            )}
            {!id && (
              <fieldset disabled={locked || session !== 'signed-in'} className="space-y-5">
                <legend className="mb-4 font-semibold">{m.catalogue_create_terms({}, o)}</legend>
                {terms.map((term, index) => (
                  <fieldset key={term.id} id={`${termsId}-${term.id}`} className="min-w-0 space-y-3">
                    <legend className="sr-only">{term.language || m.catalogue_create_language({}, o)}</legend>
                    {(['language', 'label', 'description', 'aliases'] as const).map((field) => (
                      <Field key={field}>
                        <FieldLabel htmlFor={`${termsId}-${field}-${term.id}`}>
                          {
                            {
                              language: m.catalogue_create_language({}, o),
                              label: m.catalogue_create_label({}, o),
                              description: m.catalogue_create_description({}, o),
                              aliases: m.catalogue_create_aliases({}, o),
                            }[field]
                          }
                        </FieldLabel>
                        {field === 'aliases' ? (
                          <Textarea
                            id={`${termsId}-${field}-${term.id}`}
                            value={term[field]}
                            onChange={(event) =>
                              setTerms((previous) =>
                                previous.map((value) =>
                                  value.id === term.id ? { ...value, [field]: event.target.value } : value,
                                ),
                              )
                            }
                          />
                        ) : (
                          <Input
                            id={`${termsId}-${field}-${term.id}`}
                            value={term[field]}
                            onChange={(event) =>
                              setTerms((previous) =>
                                previous.map((value) =>
                                  value.id === term.id ? { ...value, [field]: event.target.value } : value,
                                ),
                              )
                            }
                          />
                        )}
                      </Field>
                    ))}
                    {index > 0 && (
                      <CreateSubjectLanguageRemove
                        locale={locale}
                        rowId={`${termsId}-${term.id}`}
                        focusId={terms[index + 1] ? `${termsId}-language-${terms[index + 1]!.id}` : `${termsId}-add`}
                        disabled={locked || session !== 'signed-in'}
                        onRemove={() => {
                          if (locked || running.current || pending.current || session !== 'signed-in') return;
                          setTerms((previous) => previous.filter((value) => value.id !== term.id));
                          setFailure(undefined);
                        }}
                      />
                    )}
                  </fieldset>
                ))}
                <Button
                  id={`${termsId}-add`}
                  className="h-auto min-h-11 max-w-full whitespace-normal"
                  type="button"
                  variant="outline"
                  disabled={locked || session !== 'signed-in'}
                  onClick={() => {
                    if (locked || running.current || pending.current || session !== 'signed-in') return;
                    const id = nextTermId.current++;
                    setTerms((previous) => [
                      ...previous,
                      { id, language: '', label: '', description: '', aliases: '' },
                    ]);
                  }}
                >
                  {m.catalogue_create_add_language({}, o)}
                </Button>
              </fieldset>
            )}
            <p className="text-sm text-muted-foreground">{m.recipe_ingredients_help({}, o)}</p>
            {id &&
              read.public &&
              read.fields.map((field) => (
                <section key={field} className="space-y-3">
                  <h2 className="font-semibold">{name(field)}</h2>
                  {(read.public!.subject.statements[field] ?? []).map((source) => (
                    <div key={source.id} className="flex min-w-0 flex-col items-start gap-3 md:flex-row">
                      <div className="min-w-0 break-words md:flex-1">
                        <CandidateValue snak={source} related={read.public!.related} locale={locale} />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto min-h-11 max-w-full whitespace-normal"
                        disabled={rows.some((row) => row.source?.id === source.id)}
                        onClick={() =>
                          setRows([...rows, { id: crypto.randomUUID(), source, statement: statementInput(source) }])
                        }
                      >
                        {m.recipe_correct({}, o)}
                      </Button>
                    </div>
                  ))}
                </section>
              ))}
            {rows.map((row) => (
              <RecipeField
                key={row.id}
                row={row}
                read={read}
                locale={locale}
                search={search}
                disabled={locked || session !== 'signed-in'}
                transport={transport}
                {...(review ? { review } : {})}
                onChange={(statement) =>
                  setRows((previous) =>
                    previous.map((entry) => (entry.id === row.id ? { ...entry, statement } : entry)),
                  )
                }
                onOriginal={(original) =>
                  setRows((previous) => previous.map((entry) => (entry.id === row.id ? { ...entry, original } : entry)))
                }
                onRemove={() => setRows(rows.filter((entry) => entry.id !== row.id))}
              />
            ))}
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <Field className="w-full min-w-0 sm:flex-1">
                <FieldLabel htmlFor="recipe-field">{m.character_add_fact({}, o)}</FieldLabel>
                <NativeSelect
                  id="recipe-field"
                  className="w-full [&>select]:min-h-11"
                  disabled={locked}
                  value={property}
                  onChange={(event) => setProperty(event.target.value)}
                >
                  <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                  {read.fields
                    .filter(
                      (field) =>
                        read.release.properties[field]?.multivalued ||
                        !rows.some((row) => row.statement.property.id === field),
                    )
                    .map((field) => (
                      <NativeSelectOption key={field} value={field}>
                        {name(field)}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
              <Button
                type="button"
                className="h-auto min-h-11 max-w-full whitespace-normal"
                variant="outline"
                disabled={locked || session !== 'signed-in' || !property}
                onClick={() => {
                  setRows([...rows, newRow(property)]);
                  setProperty('');
                }}
              >
                {m.correction_add({}, o)}
              </Button>
            </div>
            {!id && (
              <>
                {failure && (
                  <div role="alert" className="space-y-2">
                    <p>
                      {failure.reason === 'conflict'
                        ? m.catalogue_create_conflict({}, o)
                        : failure.reason === 'invalid'
                          ? m.catalogue_create_invalid({}, o)
                          : failure.reason === 'denied'
                            ? m.catalogue_create_denied({}, o)
                            : failure.reason === 'signed-out'
                              ? m.catalogue_create_signed_out({}, o)
                              : m.catalogue_create_uncertain({}, o)}
                    </p>
                    {failure.errors?.map((error, index) => (
                      <p key={index}>
                        {name(
                          Object.keys(read.release.properties).find((field) => error.pointer.includes(field)) ?? '',
                        ) || m.catalogue_create_terms({}, o)}
                        : {m.catalogue_create_invalid_field({}, o)}
                      </p>
                    ))}
                    {failure.reason === 'conflict' && (
                      <Button
                        className={recipeActionClassName}
                        type="button"
                        onClick={() => {
                          pending.current = null;
                          setFailure(undefined);
                        }}
                      >
                        {m.catalogue_create_review_new({}, o)}
                      </Button>
                    )}
                  </div>
                )}
                <Button
                  type="submit"
                  className="h-auto min-h-11 max-w-full self-start whitespace-normal"
                  disabled={busy || session !== 'signed-in' || failure?.reason === 'conflict'}
                >
                  {busy
                    ? m.catalogue_create_saving({}, o)
                    : pending.current
                      ? m.correction_retry({}, o)
                      : m.recipe_title({}, o)}
                </Button>
              </>
            )}
          </Workspace>
        )
      )}
    </article>
  );
}

const RecipeField = catalogueEditor(RecipeFieldLive);

function RecipeFieldLive({
  row,
  read,
  locale,
  search,
  disabled,
  transport,
  review,
  onChange,
  onOriginal,
  onRemove,
}: {
  row: Row;
  read: Ready;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  transport: RecipeTransport;
  review?: (property: string, slot: CandidateSlot | undefined, session?: string) => CandidateTransport;
  onChange: (statement: StatementInput) => void;
  onRemove: () => void;
  onOriginal: (original: boolean) => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const property = row.statement.property.id;
  const definition = read.release.properties[property]!;
  const label = pickText(definition.labels, locale).text;
  const [authored, setAuthored] = useState<AuthoredField>();
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [citation, setCitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProposalResult>();
  const [reviewing, setReviewing] = useState(false);
  const command = useRef<ProposalCommand | null>(null);
  const running = useRef(false);
  const frozen = disabled || busy || !!command.current || result?.ok === true;
  const updateAuthored = (next: AuthoredField) => {
    setAuthored(next);
    onChange({ ...row.statement, value: authoredFieldValue(next) });
  };
  const slot =
    definition.relation &&
    definition.relation.group !== 'classification' &&
    row.statement.value.type === 'value' &&
    typeof row.statement.value.content === 'string'
      ? { target: row.statement.value.content }
      : undefined;
  async function submit() {
    if (!lifetime.active()) return;
    if (!read.public || running.current) return;
    command.current ??= {
      id: read.public.subject.id,
      statement: structuredClone(row.statement),
      key: crypto.randomUUID(),
    };
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.propose(command.current);
      if (!lifetime.active()) return;
      setResult(next);
      if (next.ok) command.current = null;
    } catch {
      if (!lifetime.active()) return;
      setResult({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <h2 className="font-semibold">{label}</h2>
      <fieldset disabled={frozen} className="min-w-0 space-y-4">
        {definition.datatype === 'document' ? (
          <>
            {!authored ? (
              <Button
                className={recipeActionClassName}
                type="button"
                variant="outline"
                onClick={() => updateAuthored(newAuthoredField())}
              >
                {m.recipe_replace_method({}, o)}
              </Button>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{m.recipe_method_help({}, o)}</p>
                <Field>
                  <FieldLabel>{m.catalogue_create_language({}, o)}</FieldLabel>
                  <Input
                    className={recipeInputClassName}
                    aria-label={m.catalogue_create_language({}, o)}
                    value={authored.language}
                    onChange={(event) => updateAuthored({ ...authored, language: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel>{m.subject_source_licence({}, o)}</FieldLabel>
                  <Input
                    className={recipeInputClassName}
                    aria-label={m.subject_source_licence({}, o)}
                    value={authored.licence}
                    onChange={(event) => updateAuthored({ ...authored, licence: event.target.value })}
                  />
                </Field>
                <RichTextEditor
                  label={label}
                  labels={editorLabels()}
                  value={authored.document}
                  lang={authored.language}
                  disabled={frozen}
                  onChange={(document) => updateAuthored({ ...authored, document })}
                />
                <Field orientation="horizontal">
                  <Checkbox
                    id={`original-${row.id}`}
                    checked={row.original ?? false}
                    onCheckedChange={(checked) => onOriginal(checked === true)}
                  />
                  <FieldLabel htmlFor={`original-${row.id}`}>{m.recipe_original({}, o)}</FieldLabel>
                </Field>
              </>
            )}
          </>
        ) : definition.datatype === 'wikibase-item' ? (
          <EntityPicker
            disabled={frozen}
            label={label}
            value={
              picked.length
                ? picked
                : row.statement.value.type === 'value' &&
                    typeof row.statement.value.content === 'string' &&
                    row.statement.value.content
                  ? [
                      {
                        id: row.statement.value.content,
                        title:
                          pickText(read.public?.related[row.statement.value.content]?.labels ?? {}, locale).text ||
                          m.subject_value_unlabelled({}, o),
                        types: [],
                        typeLabel: '',
                        cover: null,
                      },
                    ]
                  : []
            }
            search={async (text, signal) =>
              (await search(text, signal)).filter((entry) =>
                entry.types.some((type) => recipeTarget(read.release, property, type)),
              )
            }
            src={coverSrc}
            onValueChange={(items) => {
              setPicked(items);
              onChange({ ...row.statement, value: { type: 'value', content: items[0]?.id ?? '' } });
            }}
          />
        ) : (
          <ScalarControl
            part={row.statement}
            definition={definition}
            read={{ release: read.release, public: { related: read.public?.related ?? {} } }}
            locale={locale}
            onChange={(value) => onChange({ ...row.statement, value })}
          />
        )}
        <Field>
          <FieldLabel htmlFor={`citation-${row.id}`}>{m.relation_citation({}, o)}</FieldLabel>
          <Input
            className={recipeInputClassName}
            id={`citation-${row.id}`}
            type="url"
            value={citation}
            onChange={(event) => {
              const url = event.target.value;
              setCitation(url);
              onChange({
                ...row.statement,
                references: [
                  ...structuredClone(row.source?.references ?? []).map((reference) => ({
                    parts: reference.parts.map((part) => ({ property: { id: part.property.id }, value: part.value })),
                  })),
                  ...(url.trim()
                    ? [
                        {
                          parts: [
                            { property: { id: 'schema:url' }, value: { type: 'value' as const, content: url.trim() } },
                          ],
                        },
                      ]
                    : []),
                ],
              });
            }}
          />
        </Field>
        <div className="flex min-w-0 flex-wrap gap-3">
          <Button className={recipeActionClassName} type="button" variant="ghost" onClick={onRemove}>
            {m.recipe_remove_field({}, o)}
          </Button>
        </div>
      </fieldset>
      {result && !result.ok && <EditorFailure reason={result.reason} locale={locale} />}
      {result?.ok ? (
        <div className="space-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <p role="status">{m.correction_proposed({}, o)}</p>
            {review && (
              <Button className={recipeActionClassName} type="button" onClick={() => setReviewing(true)}>
                {m.correction_review({}, o)}
              </Button>
            )}
          </div>
          {reviewing && review && read.public && (
            <CandidateReview
              id={read.public.subject.id}
              locale={locale}
              initialProperty={property}
              exactCandidate={result.candidate}
              slot={slot}
              transport={review(property, slot, result.session)}
            />
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-3">
          {result &&
            !result.ok &&
            (result.reason === 'stale' || result.reason === 'invalid' || result.reason === 'denied') && (
              <Button
                className={recipeActionClassName}
                type="button"
                variant="outline"
                onClick={() => {
                  command.current = null;
                  setResult(undefined);
                }}
              >
                {m.catalogue_create_review_new({}, o)}
              </Button>
            )}
          {read.public && (
            <Button
              className={recipeActionClassName}
              type="button"
              disabled={
                disabled ||
                busy ||
                (definition.datatype === 'document' &&
                  (!authored || !row.original || !hasDocumentContent(authored.document))) ||
                (result && !result.ok && result.reason === 'stale')
              }
              onClick={() => void submit()}
            >
              {command.current ? m.correction_retry({}, o) : m.correction_submit({}, o)}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
