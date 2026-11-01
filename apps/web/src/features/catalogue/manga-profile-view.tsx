import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { m } from '../../paraglide/messages.js';
import { ViewHeadingActions } from '../pages/view-heading';
import { definitionText } from './definition-guide';
import { DefinitionGuideLink } from './definition-guide-view';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { EditorFailure } from './statement-editor-view';
import { MangaInitialField, type MangaRow } from './manga-profile-field';
import { MangaCorrections, type MangaCorrectionPorts } from './manga-profile-corrections';
import {
  blankMangaStatement,
  mangaDraft,
  mangaGroups,
  mangaTypes,
  type MangaCommand,
  type MangaRead,
  type MangaTransport,
  type MangaType,
} from './manga-profile';

export type MangaReady = Extract<MangaRead, { ok: true }>;
type MangaTermDraft = TermDraft & { id: number };

export function mangaGroupLabels(locale: string) {
  const o = { locale: locale as never };
  return {
    membership: m.manga_membership({}, o),
    creators: m.manga_creators({}, o),
    publication: m.manga_publication({}, o),
    classification: m.manga_classification({}, o),
    writing: m.authored_title({}, o),
  };
}

export function MangaProfileEditor({
  id,
  locale,
  session,
  transport,
  search,
  correction,
}: {
  id?: string | undefined;
  locale: string;
  session: string;
  transport: MangaTransport;
  search: EntityPickerSearch;
  correction?: MangaCorrectionPorts | undefined;
}) {
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: ['manga-profile', id, locale],
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = !query.isError && query.data?.ok ? query.data : undefined;
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <ViewHeadingActions headingClassName="font-sans" label={id ? m.manga_edit({}, o) : m.manga_title({}, o)} />
      <p className="max-w-prose text-muted-foreground">{m.manga_intro({}, o)}</p>
      {session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out' ? m.catalogue_create_signed_out({}, o) : m.candidate_loading({}, o)}
        </p>
      )}
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {read && !mangaTypes.some((type) => read.release.types[type]) && (
        <p role="status">{m.catalogue_create_empty({}, o)}</p>
      )}
      {(query.isError || (query.data && !query.data.ok)) && (
        <div className="space-y-3">
          {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
            <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
          ) : (
            <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
          )}
          <Button onClick={() => void query.refetch()}>{m.correction_reload({}, o)}</Button>
        </div>
      )}
      {id ? (
        <MangaCorrections
          read={read}
          locale={locale}
          disabled={session !== 'signed-in'}
          ports={correction}
          reload={() => query.refetch()}
        />
      ) : (
        <MangaCreate
          read={read}
          locale={locale}
          disabled={session !== 'signed-in'}
          transport={transport}
          search={search}
          refresh={() => query.refetch()}
        />
      )}
    </article>
  );
}

function MangaCreate({
  read,
  locale,
  disabled,
  transport,
  search,
  refresh,
}: {
  read: MangaReady | undefined;
  locale: string;
  disabled: boolean;
  transport: MangaTransport;
  search: EntityPickerSearch;
  refresh: () => Promise<unknown>;
}) {
  const o = { locale: locale as never };
  const termsId = useId();
  const nextTermId = useRef(1);
  const [type, setType] = useState<MangaType>('schema:ComicSeries');
  const [terms, setTerms] = useState<MangaTermDraft[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [drafts, setDrafts] = useState<Record<MangaType, MangaRow[]>>({
    'schema:ComicSeries': [],
    'schema:PublicationVolume': [],
  });
  const [independent, setIndependent] = useState(false);
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const request = useRef<MangaCommand | null>(null);
  const running = useRef(false);
  const locked = disabled || busy || !!request.current || !read;
  const rows = drafts[type];
  const groups = read ? mangaGroups(read.release, type, locale) : undefined;
  const labels = mangaGroupLabels(locale);
  function changeRows(next: MangaRow[]) {
    if (!locked) {
      setDrafts({ ...drafts, [type]: next });
      setFailure(undefined);
    }
  }
  async function submit() {
    if (!read || disabled || running.current || created || failure?.reason === 'conflict') return;
    if (!request.current) {
      const draft = mangaDraft(
        read.release,
        type,
        locale,
        terms,
        rows.map((row) => row.statement),
      );
      if (type === 'schema:PublicationVolume' && !independent)
        draft.errors.push({ pointer: '/independent', code: 'required' });
      for (const row of rows)
        if (read.release.properties[row.statement.property.id]?.datatype === 'document' && !row.original)
          draft.errors.push({ pointer: `/statements/${row.statement.property.id}`, code: 'required' });
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      request.current = { key: crypto.randomUUID(), item: draft.item, independent };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.create(request.current);
      if (result.ok) {
        setCreated(result);
        request.current = null;
      } else {
        setFailure(result);
        if (!['unavailable', 'conflict'].includes(result.reason)) request.current = null;
        if (result.refreshDefinitions) await refresh();
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function errorControl(pointer: string) {
    if (pointer === '/independent') return 'manga-independent';
    if (pointer === '/type') return 'manga-type';
    if (/^\/(labels|aliases|descriptions)\//.test(pointer)) {
      const language = pointer.split('/')[2]?.replaceAll('~1', '/').replaceAll('~0', '~');
      const term = terms.find((row) => row.language.trim() === language) ?? terms[0]!;
      const field = pointer.startsWith('/labels')
        ? 'label'
        : pointer.startsWith('/aliases')
          ? 'aliases'
          : 'description';
      return `${termsId}-${field}-${term.id}`;
    }
    const row = rows.find((row) => pointer.includes(row.statement.property.id));
    return row ? `manga-row-${row.id}` : 'manga-fields';
  }
  if (created)
    return (
      <section className="space-y-4">
        <p role="status">{m.manga_created({}, o)}</p>
        <p className="break-all font-mono text-sm">{created.id}</p>
        {created.reader.state === 'ready' ? (
          <a className={buttonVariants()} href={created.reader.href}>
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
              {m.correction_retry({}, o)}
            </Button>
          </>
        )}
      </section>
    );
  return (
    <>
      <a
        className={buttonVariants({ variant: 'outline' })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <fieldset disabled={locked} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="manga-type">{m.manga_grain({}, o)}</FieldLabel>
            <NativeSelect
              id="manga-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as MangaType);
                setFailure(undefined);
              }}
            >
              {!read?.release.types[type] && (
                <NativeSelectOption value="" disabled>
                  {m.correction_choose({}, o)}
                </NativeSelectOption>
              )}
              {mangaTypes
                .filter((id) => read?.release.types[id])
                .map((id) => {
                  const text = definitionText(read!.release.types[id]!.labels, locale);
                  return (
                    <NativeSelectOption key={id} value={id} lang={text.lang ?? undefined}>
                      {text.text}
                    </NativeSelectOption>
                  );
                })}
            </NativeSelect>
          </Field>
          <p className="text-sm text-muted-foreground">{m.manga_grain_help({}, o)}</p>
          {read?.release.types[type] && (
            <DefinitionGuideLink locale={locale} address={{ type, returnTo: `/${locale}/catalogue/manga` }} />
          )}
          {type === 'schema:PublicationVolume' && (
            <Field orientation="horizontal">
              <Checkbox
                id="manga-independent"
                checked={independent}
                onCheckedChange={(value) => setIndependent(value === true)}
              />
              <FieldLabel htmlFor="manga-independent">{m.manga_independent({}, o)}</FieldLabel>
            </Field>
          )}
        </fieldset>
        <fieldset disabled={locked} className="space-y-5">
          <legend className="mb-3 text-lg font-semibold">{m.catalogue_create_terms({}, o)}</legend>
          {terms.map((term, index) => (
            <div
              key={term.id}
              id={`${termsId}-row-${term.id}`}
              className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2"
            >
              {(['language', 'label', 'description', 'aliases'] as const).map((field) => {
                const label = {
                  language: m.catalogue_create_language({}, o),
                  label: m.catalogue_create_label({}, o),
                  description: m.catalogue_create_description({}, o),
                  aliases: m.catalogue_create_aliases({}, o),
                }[field];
                const props = {
                  id: `${termsId}-${field}-${term.id}`,
                  value: term[field],
                  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    setTerms((previous) =>
                      previous.map((item) => (item.id === term.id ? { ...item, [field]: event.target.value } : item)),
                    );
                    setFailure(undefined);
                  },
                };
                return (
                  <Field key={field}>
                    <FieldLabel htmlFor={props.id}>{label}</FieldLabel>
                    {field === 'aliases' ? <Textarea {...props} /> : <Input {...props} />}
                  </Field>
                );
              })}
              {index > 0 && (
                <CreateSubjectLanguageRemove
                  locale={locale}
                  rowId={`${termsId}-row-${term.id}`}
                  focusId={terms[index + 1] ? `${termsId}-language-${terms[index + 1]!.id}` : `${termsId}-add-language`}
                  disabled={locked}
                  onRemove={() => {
                    if (locked || running.current || request.current) return;
                    setTerms((previous) => previous.filter((row) => row.id !== term.id));
                    setFailure(undefined);
                  }}
                />
              )}
            </div>
          ))}
          <Button
            id={`${termsId}-add-language`}
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => {
              if (locked || running.current || request.current) return;
              setTerms((previous) => [
                ...previous,
                { id: nextTermId.current++, language: '', label: '', description: '', aliases: '' },
              ]);
            }}
          >
            {m.catalogue_create_add_language({}, o)}
          </Button>
        </fieldset>
        <div id="manga-fields" tabIndex={-1} className="space-y-6">
          {read &&
            groups &&
            Object.entries(groups)
              .filter(([, fields]) => fields.length)
              .map(([group, fields]) => (
                <section key={group} className="space-y-4">
                  <h2 className="font-sans text-xl font-semibold">{labels[group as keyof typeof labels]}</h2>
                  {group === 'membership' && (
                    <p className="text-sm text-muted-foreground">{m.manga_order_help({}, o)}</p>
                  )}
                  {rows
                    .filter((row) => fields.includes(row.statement.property.id))
                    .map((row) => (
                      <MangaInitialField
                        key={row.id}
                        row={row}
                        read={read}
                        type={type}
                        locale={locale}
                        search={search}
                        disabled={locked}
                        onChange={(next) => changeRows(rows.map((item) => (item.id === row.id ? next : item)))}
                        onRemove={() => changeRows(rows.filter((item) => item.id !== row.id))}
                      />
                    ))}
                  <AddField
                    label={labels[group as keyof typeof labels]}
                    disabled={locked}
                    fields={fields.filter(
                      (id) =>
                        read.release.properties[id]!.multivalued ||
                        !rows.some((row) => row.statement.property.id === id),
                    )}
                    name={(id) => pickText(read.release.properties[id]!.labels, locale)}
                    onAdd={(property) =>
                      changeRows([
                        ...rows,
                        {
                          id: crypto.randomUUID(),
                          statement: blankMangaStatement(property),
                          label: pickText(read.release.properties[property]!.labels, locale),
                        },
                      ])
                    }
                    locale={locale}
                  />
                </section>
              ))}
          {read &&
            groups &&
            rows
              .filter((row) => !Object.values(groups).flat().includes(row.statement.property.id))
              .map((row) => (
                <section
                  key={row.id}
                  id={`manga-row-${row.id}`}
                  tabIndex={-1}
                  className="space-y-3 rounded-xl border p-4"
                >
                  <h3 lang={row.label?.lang ?? undefined}>{row.label?.text || m.correction_invalid_part({}, o)}</h3>
                  <p role="alert">{m.correction_stale({}, o)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={locked}
                    onClick={() => changeRows(rows.filter((item) => item.id !== row.id))}
                  >
                    {m.recipe_remove_field({}, o)}
                  </Button>
                </section>
              ))}
        </div>
        {failure && (
          <div className="space-y-3 rounded-xl border border-destructive/50 p-4">
            <EditorFailure locale={locale} reason={failure.reason} />
            {!!failure.errors?.length && (
              <ul className="list-disc ps-5">
                {failure.errors.map((error, index) => (
                  <li key={index}>
                    <a className="underline" href={`#${errorControl(error.pointer)}`}>
                      {m.correction_invalid_part({}, o)} ·{' '}
                      {rows.find((row) => error.pointer.includes(row.statement.property.id))
                        ? pickText(
                            read?.release.properties[
                              rows.find((row) => error.pointer.includes(row.statement.property.id))!.statement.property
                                .id
                            ]?.labels ?? {},
                            locale,
                          ).text
                        : m.catalogue_create_terms({}, o)}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {failure.reason === 'conflict' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  request.current = null;
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
          disabled={busy || disabled || !read?.release.types[type] || failure?.reason === 'conflict'}
        >
          {busy ? m.catalogue_create_saving({}, o) : request.current ? m.correction_retry({}, o) : m.manga_title({}, o)}
        </Button>
      </form>
    </>
  );
}

function AddField({
  label,
  fields,
  name,
  onAdd,
  disabled,
  locale,
}: {
  label: string;
  fields: string[];
  name: (id: string) => ReturnType<typeof pickText>;
  onAdd: (id: string) => void;
  disabled: boolean;
  locale: string;
}) {
  const [property, setProperty] = useState('');
  const o = { locale: locale as never };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="min-w-0 flex-1">
        <FieldLabel>{label}</FieldLabel>
        <NativeSelect
          aria-label={label}
          value={fields.includes(property) ? property : ''}
          disabled={disabled}
          onChange={(event) => setProperty(event.target.value)}
        >
          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
          {fields.map((id) => (
            <NativeSelectOption key={id} value={id} lang={name(id).lang ?? undefined}>
              {name(id).text}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || !fields.includes(property)}
        onClick={() => {
          onAdd(property);
          setProperty('');
        }}
      >
        {m.correction_add({}, o)}
      </Button>
    </div>
  );
}
