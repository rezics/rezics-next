import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useId, useRef, useState } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import {
  albumDraft,
  albumFields,
  albumTarget,
  albumType,
  type AlbumCommand,
  type AlbumTransport,
} from './album-profile';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import { QualifierInput } from './relation-editor';
import type { StatementInput } from './statement-editor';
import { ScalarControl } from './statement-editor-view';
import { DefinitionMeaning } from './definition-meaning';

type Row = { id: string; statement: StatementInput };

/** Initial facts only. Every optional assertion begins with the reader explicitly adding its field. */
export function AlbumProfileCreate({
  release: initialRelease,
  locale,
  transport,
  search,
  enabled,
}: {
  release: Release;
  locale: string;
  transport: AlbumTransport;
  search: EntityPickerSearch;
  enabled: boolean;
}) {
  const o = { locale: locale as never };
  const [release, setRelease] = useState(initialRelease);
  const [metadataFailure, setMetadataFailure] = useState(false);
  const termsId = useId();
  const nextTermId = useRef(1);
  const [terms, setTerms] = useState<(TermDraft & { id: number })[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [rows, setRows] = useState<Row[]>([]);
  const [property, setProperty] = useState('');
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AlbumCommand | null>(null);
  const running = useRef(false);
  const fields = albumFields(release);
  const choices = [...fields.scalar, ...fields.relations, ...fields.classifications];
  const locked = busy || !!pending.current || !enabled || metadataFailure;
  const definiteFailure = failure && failure.reason !== 'unavailable';

  async function submit() {
    if (running.current || created || !enabled || metadataFailure || (pending.current && definiteFailure)) return;
    if (!pending.current) {
      const draft = albumDraft(
        release,
        terms,
        rows.map((row) => row.statement),
      );
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
      if (result.ok) setCreated(result);
      else {
        setFailure(result);
        if (result.refreshDefinitions) {
          try {
            const next = await transport.load();
            if (next.ok && next.release.types[albumType]) {
              setRelease(next.release);
              setMetadataFailure(false);
            } else setMetadataFailure(true);
          } catch {
            setMetadataFailure(true);
          }
        }
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  if (created)
    return (
      <section className="space-y-4 rounded-xl border border-border p-5">
        <p role="status">{m.catalogue_create_created({}, o)}</p>
        <code className="break-all text-sm">{created.id}</code>
        {created.reader.state === 'ready' ? (
          <a className={buttonVariants()} href={created.reader.href}>
            {m.catalogue_create_open({}, o)}
          </a>
        ) : (
          <>
            <p>
              {created.reader.state === 'concealed'
                ? m.catalogue_create_concealed({}, o)
                : m.catalogue_create_reader_unavailable({}, o)}
            </p>
            <Button
              disabled={busy}
              onClick={async () => {
                if (running.current) return;
                running.current = true;
                setBusy(true);
                try {
                  setCreated({ ...created, reader: await transport.read(created.id) });
                } catch {
                  setCreated({ ...created, reader: { state: 'unavailable' } });
                } finally {
                  running.current = false;
                  setBusy(false);
                }
              }}
            >
              {m.catalogue_create_retry({}, o)}
            </Button>
          </>
        )}
      </section>
    );

  return (
    <form
      className="space-y-6"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <a
        className={buttonVariants({ variant: 'outline' })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <fieldset id="album-terms" disabled={locked} className="space-y-5 rounded-xl border border-border p-4 sm:p-5">
        <legend className="px-2 font-semibold">{m.catalogue_create_terms({}, o)}</legend>
        {terms.map((term, index) => (
          <fieldset
            key={term.id}
            id={`${termsId}-${term.id}`}
            className="grid min-w-0 gap-3 border-b border-border pb-4 sm:grid-cols-2"
          >
            <legend className="sr-only">{term.language || m.catalogue_create_language({}, o)}</legend>
            {(['language', 'label', 'description', 'aliases'] as const).map((field) => {
              const label = {
                language: m.catalogue_create_language({}, o),
                label: m.catalogue_create_label({}, o),
                description: m.catalogue_create_description({}, o),
                aliases: m.catalogue_create_aliases({}, o),
              }[field];
              const update = (value: string) =>
                setTerms((previous) => previous.map((row) => (row.id === term.id ? { ...row, [field]: value } : row)));
              return (
                <Field key={field}>
                  <FieldLabel htmlFor={`${termsId}-${field}-${term.id}`}>{label}</FieldLabel>
                  {field === 'aliases' ? (
                    <Textarea
                      id={`${termsId}-${field}-${term.id}`}
                      value={term[field]}
                      onChange={(event) => update(event.target.value)}
                    />
                  ) : (
                    <Input
                      id={`${termsId}-${field}-${term.id}`}
                      value={term[field]}
                      onChange={(event) => update(event.target.value)}
                    />
                  )}
                </Field>
              );
            })}
            {index > 0 && (
              <CreateSubjectLanguageRemove
                locale={locale}
                rowId={`${termsId}-${term.id}`}
                focusId={
                  terms[index + 1]
                    ? `${termsId}-language-${terms[index + 1]!.id}`
                    : `${termsId}-add`
                }
                disabled={locked}
                onRemove={() => {
                  if (locked || running.current || pending.current) return;
                  setTerms((previous) => previous.filter((row) => row.id !== term.id));
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
          disabled={locked}
          onClick={() => {
            if (locked || running.current || pending.current) return;
            const id = nextTermId.current++;
            setTerms((previous) => [...previous, { id, language: '', label: '', description: '', aliases: '' }]);
          }}
        >
          {m.catalogue_create_add_language({}, o)}
        </Button>
      </fieldset>
      <section className="space-y-4" aria-label={m.album_initial_facts({}, o)}>
        <h2 className="text-xl font-semibold">{m.album_initial_facts({}, o)}</h2>
        <p className="text-sm text-muted-foreground">{m.album_initial_help({}, o)}</p>
        {rows.map((row, index) => (
          <AlbumInitialField
            key={row.id}
            row={row}
            index={index}
            release={release}
            locale={locale}
            search={search}
            disabled={locked}
            change={(statement) =>
              setRows((previous) => previous.map((item) => (item.id === row.id ? { ...item, statement } : item)))
            }
            remove={() => setRows((previous) => previous.filter((item) => item.id !== row.id))}
          />
        ))}
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <Field className="w-full min-w-0 sm:flex-1">
            <FieldLabel htmlFor="album-field">{m.character_add_fact({}, o)}</FieldLabel>
            <NativeSelect
              id="album-field"
              className="w-full [&>select]:min-h-11"
              value={property}
              onChange={(event) => setProperty(event.target.value)}
            >
              <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
              {choices
                .filter(
                  (id) => release.properties[id]!.multivalued || !rows.some((row) => row.statement.property.id === id),
                )
                .map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {pickText(release.properties[id]!.labels, locale).text}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 max-w-full whitespace-normal"
            disabled={!choices.includes(property)}
            onClick={() => {
              setRows([
                ...rows,
                {
                  id: crypto.randomUUID(),
                  statement: {
                    property: { id: property },
                    value: { type: 'value', content: '' },
                    qualifiers: [],
                    references: [],
                    rank: 'normal',
                  },
                },
              ]);
              setProperty('');
            }}
          >
            {m.correction_add({}, o)}
          </Button>
        </fieldset>
      </section>
      {metadataFailure && (
        <div className="space-y-3">
          <p role="alert">{m.album_missing({}, o)}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (running.current) return;
              running.current = true;
              setBusy(true);
              try {
                const next = await transport.load();
                if (next.ok && next.release.types[albumType]) {
                  setRelease(next.release);
                  setMetadataFailure(false);
                }
              } catch {
                setMetadataFailure(true);
              } finally {
                running.current = false;
                setBusy(false);
              }
            }}
          >
            {m.correction_reload({}, o)}
          </Button>
        </div>
      )}
      {failure && (
        <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
          <p>
            {failure.reason === 'invalid'
              ? m.catalogue_create_invalid({}, o)
              : failure.reason === 'conflict'
                ? m.catalogue_create_conflict({}, o)
                : failure.reason === 'denied'
                  ? m.catalogue_create_denied({}, o)
                  : failure.reason === 'signed-out'
                    ? m.catalogue_create_signed_out({}, o)
                    : m.catalogue_create_uncertain({}, o)}
          </p>
          {failure.errors?.map((error, index) => {
            const row = rows.find((row) => error.pointer.includes(row.statement.property.id));
            return (
              <p key={index}>
                <a className="underline" href={row ? `#album-row-${row.id}` : '#album-terms'}>
                  {row
                    ? pickText(release.properties[row.statement.property.id]?.labels ?? {}, locale).text
                    : m.catalogue_create_terms({}, o)}
                  : {m.catalogue_create_invalid_field({}, o)}
                </a>
              </p>
            );
          })}
          {pending.current && definiteFailure && (
            <Button
              type="button"
              variant="outline"
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
      <Button type="submit" disabled={busy || !enabled || metadataFailure || (!!pending.current && !!definiteFailure)}>
        {busy
          ? m.catalogue_create_saving({}, o)
          : pending.current
            ? m.catalogue_create_retry({}, o)
            : m.album_create({}, o)}
      </Button>
    </form>
  );
}

function AlbumInitialField({
  row,
  index,
  release,
  locale,
  search,
  disabled,
  change,
  remove,
}: {
  row: Row;
  index: number;
  release: Release;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  change: (statement: StatementInput) => void;
  remove: () => void;
}) {
  const o = { locale: locale as never };
  const [picked, setPicked] = useState<Record<string, EntityPickerSubject>>({});
  const statement = row.statement;
  const definition = release.properties[statement.property.id];
  const qualifiers = statement.qualifiers ?? [];
  const named = (id: string) => pickText(release.properties[id]?.labels ?? {}, locale).text;
  const target = (value: unknown): EntityPickerSubject[] =>
    typeof value === 'string' && value
      ? [
          picked[value] ?? {
            id: value,
            title: m.subject_value_unlabelled({}, o),
            types: [],
            typeLabel: '',
            cover: null,
          },
        ]
      : [];
  const remember = (items: EntityPickerSubject[]) =>
    setPicked((previous) => ({ ...previous, ...Object.fromEntries(items.map((item) => [item.id, item])) }));
  const targetSearch =
    (property: string): EntityPickerSearch =>
    async (text, signal) =>
      (await search(text, signal)).filter((item) => albumTarget(release, property, item.types));
  return (
    <fieldset
      id={`album-row-${row.id}`}
      disabled={disabled}
      className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-5"
    >
      <legend className="px-2 font-semibold">
        <DefinitionMeaning values={definition?.labels} locale={locale} />
      </legend>
      {(!definition || !release.types[albumType]?.properties.includes(statement.property.id)) && (
        <p role="alert">{m.correction_stale({}, o)}</p>
      )}
      <p className="text-sm text-muted-foreground">
        <DefinitionMeaning values={definition?.descriptions} locale={locale} />
      </p>
      {definition?.datatype === 'wikibase-item' ? (
        <EntityPicker
          label={named(statement.property.id)}
          search={targetSearch(statement.property.id)}
          src={coverSrc}
          disabled={disabled}
          value={statement.value.type === 'value' ? target(statement.value.content) : []}
          onValueChange={(items) => {
            remember(items);
            change({ ...statement, value: { type: 'value', content: items[0]?.id ?? '' } });
          }}
        />
      ) : (
        <ScalarControl
          part={statement}
          definition={definition}
          read={{ release, public: { related: {} } }}
          locale={locale}
          onChange={(value) => change({ ...statement, value })}
        />
      )}
      {qualifiers.map((part, at) => {
        const metadata = release.properties[part.property.id];
        return (
          <div key={at} className="flex min-w-0 items-end gap-2">
            <div className="min-w-0 flex-1">
              <QualifierInput
                definition={
                  metadata
                    ? {
                        id: part.property.id,
                        label: named(part.property.id),
                        datatype: metadata.datatype,
                        targets: metadata.targets ?? [],
                      }
                    : undefined
                }
                snak={{ ...part, property: { ...part.property, data_type: metadata?.datatype ?? 'string' } }}
                index={index * 100 + at}
                label={named(part.property.id)}
                search={targetSearch(part.property.id)}
                target={target}
                remember={remember}
                disabled={disabled}
                onChange={(value) =>
                  change({
                    ...statement,
                    qualifiers: qualifiers.map((item, pos) => (pos === at ? { ...item, value } : item)),
                  })
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              aria-label={`${m.relation_remove({}, o)}: ${named(part.property.id)}`}
              onClick={() => change({ ...statement, qualifiers: qualifiers.filter((_, pos) => pos !== at) })}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        );
      })}
      {!!definition?.qualifiers.length && (
        <Field>
          <FieldLabel htmlFor={`album-qualifier-${row.id}`}>{m.relation_qualifier({}, o)}</FieldLabel>
          <NativeSelect
            id={`album-qualifier-${row.id}`}
            value=""
            onChange={(event) => {
              const id = event.target.value;
              if (definition.qualifiers.includes(id))
                change({
                  ...statement,
                  qualifiers: [...qualifiers, { property: { id }, value: { type: 'value', content: '' } }],
                });
            }}
          >
            <NativeSelectOption value="">{m.relation_add_qualifier({}, o)}</NativeSelectOption>
            {definition.qualifiers
              .filter((id) => !!release.properties[id] && !qualifiers.some((part) => part.property.id === id))
              .map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {named(id)}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`album-citation-${row.id}`}>{m.relation_citation({}, o)}</FieldLabel>
        <Input
          id={`album-citation-${row.id}`}
          type="url"
          value={
            statement.references[0]?.parts[0]?.value.type === 'value'
              ? String(statement.references[0].parts[0].value.content)
              : ''
          }
          onChange={(event) =>
            change({
              ...statement,
              references: event.target.value
                ? [
                    {
                      parts: [
                        { property: { id: 'schema:url' }, value: { type: 'value', content: event.target.value } },
                      ],
                    },
                  ]
                : [],
            })
          }
        />
      </Field>
      <Button type="button" variant="ghost" onClick={remove}>
        {m.recipe_remove_field({}, o)}
      </Button>
    </fieldset>
  );
}
