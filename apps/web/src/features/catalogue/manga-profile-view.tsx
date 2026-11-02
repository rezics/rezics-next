import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasDocumentContent } from '@rezics/document';
import { pickText } from '@rezics/composition';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { m } from '../../paraglide/messages.js';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { ViewHeadingActions } from '../pages/view-heading';
import { definitionText } from './definition-guide';
import { DefinitionGuideLink } from './definition-guide-view';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { EditorFailure } from './statement-editor-view';
import { MangaInitialField, MangaRowRemove, type MangaRow } from './manga-profile-field';
import { mangaCreateFeedback } from './manga-create-feedback';
import { MangaCorrections, type MangaCorrectionPorts } from './manga-profile-corrections';
import {
  blankMangaStatement,
  mangaDraft,
  mangaGroups,
  isMangaType,
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

export const MangaProfileEditor = catalogueEditor(MangaProfileEditorLive);

function MangaProfileEditorLive({
  id,
  locale,
  session,
  transport,
  search,
  correction,
  retrySession,
}: {
  id?: string | undefined;
  locale: string;
  session: string;
  transport: MangaTransport;
  search: EntityPickerSearch;
  correction?: MangaCorrectionPorts | undefined;
  retrySession?: (() => Promise<unknown>) | undefined;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['manga-profile', id, locale], lifetime.generation],
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const candidate = query.data?.ok ? query.data : undefined;
  const subject = candidate?.public?.subject;
  const originalType = useRef<string | undefined>(undefined);
  if (id && subject?.id === id && isMangaType(subject.type)) originalType.current ??= subject.type;
  const matches = !id || (subject?.id === id && subject?.type === originalType.current);
  const read = !query.isError && (!id || !query.isFetching) && matches ? candidate : undefined;
  const failed = !!(query.isError || (query.data && !query.data.ok) || (candidate && !matches));
  const boundary = useRef<HTMLDivElement>(null);
  const running = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [completion, setCompletion] = useState<Awaited<ReturnType<typeof query.refetch>>>();
  // An observed read transition retires callbacks from its previous failure shell.
  const origin = useMemo(() => ({}), [query.dataUpdatedAt, query.errorUpdatedAt, query.fetchStatus]);
  const currentOrigin = useRef(origin);
  currentOrigin.current = origin;
  async function retryRead() {
    if (!lifetime.active() || currentOrigin.current !== origin || !failed || query.isFetching || running.current)
      return;
    running.current = true;
    setRetrying(true);
    setCompletion(undefined);
    const result = await query.refetch({ cancelRefetch: false });
    if (!lifetime.active()) return;
    running.current = false;
    setRetrying(false);
    setCompletion(result);
  }
  useLayoutEffect(() => {
    if (
      !completion ||
      query.isFetching ||
      completion.data !== query.data ||
      completion.error !== query.error ||
      completion.dataUpdatedAt !== query.dataUpdatedAt ||
      completion.errorUpdatedAt !== query.errorUpdatedAt
    )
      return;
    setCompletion(undefined);
    if (lifetime.active() && (failed || (read && (!id || (session === 'signed-in' && read.public)))))
      boundary.current?.focus();
  }, [completion, query, lifetime, failed, read, id, session]);
  const pending = retrying || (failed && query.isFetching);
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <ViewHeadingActions headingClassName="font-sans" label={id ? m.manga_edit({}, o) : m.manga_title({}, o)} />
      <p className="max-w-prose text-muted-foreground">{m.manga_intro({}, o)}</p>
      {session !== 'signed-in' &&
        (session === 'unavailable' ? (
          <div className="space-y-3">
            <p role="alert">{m.catalogue_create_unavailable({}, o)}</p>
            <Button onClick={() => void retrySession?.()} disabled={!retrySession}>
              {m.erasure_retry_session({}, o)}
            </Button>
          </div>
        ) : (
          <p role="status">
            {session === 'signed-out' ? m.catalogue_create_signed_out({}, o) : m.candidate_loading({}, o)}
          </p>
        ))}
      <div
        ref={boundary}
        tabIndex={-1}
        aria-label={id ? m.manga_edit({}, o) : m.manga_title({}, o)}
        aria-busy={pending}
        className="space-y-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {(query.isPending || pending) && <p role="status">{m.candidate_loading({}, o)}</p>}
        {read && !mangaTypes.some((type) => read.release.types[type]) && (
          <p role="status">{m.catalogue_create_empty({}, o)}</p>
        )}
        {failed && (
          <div className="space-y-3">
            {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
              <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
            ) : (
              <EditorFailure
                locale={locale}
                reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'}
              />
            )}
            <Button onClick={() => void retryRead()} disabled={pending}>
              {pending ? m.candidate_loading({}, o) : m.correction_reload({}, o)}
            </Button>
          </div>
        )}
        {id ? (
          <MangaCorrections
            read={read}
            revision={String(query.dataUpdatedAt)}
            locale={locale}
            disabled={session !== 'signed-in'}
            ports={correction}
            reload={() => query.refetch()}
          />
        ) : (
          <AuthoringDepartureBoundary>
            <MangaCreate
              read={read}
              locale={locale}
              disabled={session !== 'signed-in'}
              transport={transport}
              search={search}
              refresh={() => query.refetch()}
            />
          </AuthoringDepartureBoundary>
        )}
      </div>
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
  const lifetime = useEditorLifetime();
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
  const [retired, setRetired] = useState(false);
  // Both native Type holders belong to this workspace, including hidden authored values.
  // Inspect state only: preparing a command can validate or publish submission feedback.
  const dirty =
    type !== 'schema:ComicSeries' ||
    independent ||
    terms.some(
      (term, index) =>
        !!(term.label || term.description || term.aliases) || term.language !== (index === 0 ? locale : ''),
    ) ||
    Object.values(drafts).some((holder) => holder.length > 0);
  const departure = useAuthoringDeparture(
    () => lifetime.active() && !created && (dirty || running.current || !!request.current),
    () => running.current || !!request.current,
    String(lifetime.generation),
    undefined,
    () => {
      // A sent native command may still finish. Retire only this local caller and recovery.
      lifetime.retire();
      request.current = null;
      running.current = false;
      setRetired(true);
    },
    undefined,
    {
      title: m.thread_authoring_leave_title({}, o),
      unsaved: m.thread_authoring_leave_unsaved({}, o),
      pending: m.thread_authoring_leave_pending({}, o),
    },
  );
  const locked = disabled || busy || !!request.current || !read;
  const rows = drafts[type];
  const groups = read ? mangaGroups(read.release, type, locale) : undefined;
  const labels = mangaGroupLabels(locale);
  const feedback = mangaCreateFeedback(failure?.errors ?? [], rows, terms, read, locale, termsId, type);
  const removalEpoch = useRef(0);
  const epoch = removalEpoch.current;
  const removalAllowed = () =>
    lifetime.active() && epoch === removalEpoch.current && !locked && !running.current && !request.current;
  function changeRows(next: MangaRow[]) {
    if (removalAllowed()) {
      setDrafts({ ...drafts, [type]: next });
      setFailure(undefined);
    }
  }
  async function submit() {
    if (!lifetime.active()) return;
    removalEpoch.current++;
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
          draft.errors.push({
            pointer: `/statements/${row.statement.property.id}/${rows.filter((item) => item.statement.property.id === row.statement.property.id).indexOf(row)}/original`,
            code: 'required',
          });
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
      if (!lifetime.active()) return;
      if (result.ok) {
        departure.release();
        setCreated(result);
        request.current = null;
      } else {
        setFailure(result);
        if (!['unavailable', 'conflict'].includes(result.reason)) request.current = null;
        if (result.refreshDefinitions) await refresh();
        if (!lifetime.active()) return;
      }
    } catch {
      if (!lifetime.active()) return;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  if (retired) return null;
  if (created)
    return (
      <section className="min-w-0 [overflow-wrap:anywhere]">
        <ContentItemFrame as="div" className="min-w-0 space-y-4 py-4">
          <ContentItemHeading className="font-sans text-xl font-semibold">
            <span role="status">{m.manga_created({}, o)}</span>
          </ContentItemHeading>
          <p className="break-all font-mono text-sm">{created.id}</p>
          {created.reader.state === 'ready' ? (
            <MangaNavigationLink
              className={buttonVariants({ className: 'h-auto min-h-11 max-w-full whitespace-normal text-start' })}
              href={created.reader.href}
            >
              {m.candidate_view_public({}, o)}
            </MangaNavigationLink>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
              </p>
              <Button
                className="h-auto min-h-11 max-w-full whitespace-normal text-start"
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
                    running.current = false;
                    setBusy(false);
                  }
                }}
              >
                {m.correction_retry({}, o)}
              </Button>
            </>
          )}
        </ContentItemFrame>
      </section>
    );
  return (
    <>
      <MangaNavigationLink
        className={buttonVariants({
          variant: 'outline',
          className:
            'h-auto min-h-11 max-w-full whitespace-normal text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </MangaNavigationLink>
      <form
        className="min-w-0 space-y-8 [overflow-wrap:anywhere] [&_label]:whitespace-normal [&_label]:text-start [&_input]:min-w-0 [&_textarea]:min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <legend className="mb-3 max-w-full">
            <ContentItemHeading className="font-sans text-xl font-semibold">{m.manga_grain({}, o)}</ContentItemHeading>
          </legend>
          <ContentItemFrame as="div" className="min-w-0 space-y-4 py-3 sm:py-4">
            <Field className="min-w-0">
              <FieldLabel htmlFor="manga-type">{m.manga_grain({}, o)}</FieldLabel>
              <NativeSelect
                className="w-full min-w-0"
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
                  aria-invalid={feedback.some((error) => error.target === 'manga-independent') || undefined}
                  aria-describedby={
                    feedback
                      .filter((error) => error.target === 'manga-independent')
                      .map((error) => error.id)
                      .join(' ') || undefined
                  }
                  onCheckedChange={(value) => {
                    setIndependent(value === true);
                    setFailure(undefined);
                  }}
                />
                <FieldLabel htmlFor="manga-independent">{m.manga_independent({}, o)}</FieldLabel>
              </Field>
            )}
          </ContentItemFrame>
        </fieldset>
        <fieldset disabled={locked} className="min-w-0 space-y-5">
          <legend className="mb-3 max-w-full">
            <ContentItemHeading className="font-sans text-xl font-semibold">
              {m.catalogue_create_terms({}, o)}
            </ContentItemHeading>
          </legend>
          {terms.map((term, index) => (
            <ContentItemFrame
              as="div"
              key={term.id}
              id={`${termsId}-row-${term.id}`}
              className="grid min-w-0 gap-4 py-3 sm:grid-cols-2 sm:py-4"
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
                  'aria-invalid':
                    feedback.some((error) => error.target === `${termsId}-${field}-${term.id}`) || undefined,
                  'aria-describedby':
                    feedback
                      .filter((error) => error.target === `${termsId}-${field}-${term.id}`)
                      .map((error) => error.id)
                      .join(' ') || undefined,
                  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    setTerms((previous) =>
                      previous.map((item) => (item.id === term.id ? { ...item, [field]: event.target.value } : item)),
                    );
                    setFailure(undefined);
                  },
                };
                return (
                  <Field key={field} className="min-w-0">
                    <FieldLabel htmlFor={props.id}>{label}</FieldLabel>
                    {field === 'aliases' ? <Textarea {...props} /> : <Input {...props} />}
                  </Field>
                );
              })}
              {index > 0 && (
                <CreateSubjectLanguageRemove
                  locale={locale}
                  populated={!!(term.language || term.label || term.description || term.aliases)}
                  rowId={`${termsId}-row-${term.id}`}
                  focusId={terms[index + 1] ? `${termsId}-language-${terms[index + 1]!.id}` : `${termsId}-add-language`}
                  disabled={locked}
                  onRemove={() => {
                    if (locked || running.current || request.current) return false;
                    setTerms((previous) => previous.filter((row) => row.id !== term.id));
                    setFailure(undefined);
                    return true;
                  }}
                />
              )}
            </ContentItemFrame>
          ))}
          <Button
            className="h-auto min-h-11 max-w-full whitespace-normal text-start"
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
        <div
          id="manga-fields"
          tabIndex={-1}
          className="min-w-0 space-y-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {read &&
            groups &&
            Object.entries(groups)
              .filter(([, fields]) => fields.length)
              .map(([group, fields]) => (
                <section key={group} className="min-w-0">
                  <ContentItemFrame as="div" className="min-w-0 space-y-4 py-3 sm:py-4">
                    <ContentItemHeading className="font-sans text-xl font-semibold">
                      {labels[group as keyof typeof labels]}
                    </ContentItemHeading>
                    <div data-content-item-slot="preview" className="min-w-0 space-y-4">
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
                            removalAllowed={removalAllowed}
                            feedback={{
                              id: `manga-row-${row.id}`,
                              errors: feedback,
                            }}
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
                    </div>
                  </ContentItemFrame>
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
                  className="min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ContentItemFrame as="div" className="min-w-0 space-y-3 py-3 sm:py-4">
                    <ContentItemHeading
                      level={3}
                      className="font-sans text-lg font-semibold"
                      lang={row.label?.lang ?? undefined}
                    >
                      {row.label?.text || m.correction_invalid_part({}, o)}
                    </ContentItemHeading>
                    <p role="alert">{m.correction_stale({}, o)}</p>
                    <details>
                      <summary className="cursor-pointer">{m.catalogue_creation_technical_details({}, o)}</summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs">
                        {mangaRetiredAssertionSnapshot(row)}
                      </pre>
                    </details>
                    <MangaRowRemove
                      row={row}
                      locale={locale}
                      disabled={locked}
                      populated={retiredMangaRowPopulated(row)}
                      removalAllowed={removalAllowed}
                      onRemove={() => changeRows(rows.filter((item) => item !== row))}
                    />
                  </ContentItemFrame>
                </section>
              ))}
        </div>
        {failure && (
          <ContentItemFrame
            as="div"
            className="min-w-0 space-y-3 py-4 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline-ring"
          >
            <EditorFailure locale={locale} reason={failure.reason} />
            {!!failure.errors?.length && (
              <ul className="list-disc ps-5">
                {feedback.map((error, index) => (
                  <li key={error.id} id={error.id}>
                    <a
                      className="underline"
                      href={`#${error.target}`}
                      onClick={(event) => {
                        event.preventDefault();
                        const target = event.currentTarget
                          .closest('form')
                          ?.querySelector<HTMLElement>(`[id="${CSS.escape(error.target)}"]`);
                        const control = target?.hasAttribute('data-manga-picker')
                          ? (target.querySelector<HTMLElement>('[role="combobox"]') ?? target)
                          : target;
                        control?.focus();
                      }}
                    >
                      {error.label}
                    </a>
                    <p>{error.instruction}</p>
                    {error.instruction.includes(m.correction_error_uneditable({}, o)) && (
                      <details>
                        <summary>{m.catalogue_creation_technical_details({}, o)}</summary>
                        <code>{failure.errors![index]!.pointer}</code>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {failure.reason === 'conflict' && (
              <Button
                className="h-auto min-h-11 max-w-full whitespace-normal text-start"
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
          </ContentItemFrame>
        )}
        <Button
          className="h-auto min-h-11 max-w-full whitespace-normal text-start"
          type="submit"
          disabled={busy || disabled || !read?.release.types[type] || failure?.reason === 'conflict'}
        >
          {busy ? m.catalogue_create_saving({}, o) : request.current ? m.correction_retry({}, o) : m.manga_title({}, o)}
        </Button>
      </form>
    </>
  );
}

export function mangaRetiredAssertionSnapshot(row: MangaRow): string {
  return JSON.stringify(row.statement, null, 2);
}

export function retiredMangaRowPopulated(row: MangaRow): boolean {
  const hasValue = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return Object.values(value).some(hasValue);
    return true;
  };
  return (
    row.statement.value.type !== 'value' ||
    (row.authored
      ? hasDocumentContent(row.authored.document) || !!row.authored.language.trim() || !!row.authored.licence.trim()
      : hasValue(row.statement.value.content)) ||
    !!row.original ||
    !!row.statement.qualifiers?.length ||
    !!row.statement.references?.some((reference) => reference.parts.length) ||
    !!Object.values(row.targets ?? {}).some((targets) => targets.length)
  );
}

/** Use router navigation in the page and ordinary links in isolated editor compositions. */
function MangaNavigationLink({ href, children, className }: { href: string; children: ReactNode; className: string }) {
  const router = useRouter({ warn: false });
  return router ? (
    <Link to={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
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
  const selectId = useId();
  const o = { locale: locale as never };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      <Field className="min-w-0 basis-full sm:basis-48 sm:flex-1">
        <FieldLabel htmlFor={selectId} className="whitespace-normal [overflow-wrap:anywhere]">
          {label}
        </FieldLabel>
        <NativeSelect
          id={selectId}
          className="w-full min-w-0"
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
        className="h-auto min-h-11 max-w-full whitespace-normal text-start"
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
