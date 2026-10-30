import { LiteraryProfileEntry } from './literary-profile-entry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { DefinitionGuideLink } from './definition-guide-view';
import { GameProfileEntry } from './game-profile-entry';
import type { ReactNode } from 'react';
import type { InitialSubject } from './create-subject';
import type { Violation } from '@rezics/definitions/validate';
import { RecipeEditorEntry } from './recipe-editor-entry';
import { CharacterProfileEntry } from './character-profile-entry';
import { MangaProfileEntry } from './manga-profile-entry';
import { PeopleProfileEntry } from './people-profile-entry';
import {
  initialTerms,
  type CreateFailure,
  type CreateResult,
  type CreateSubjectCommand,
  type CreateTransport,
  type TermDraft,
} from './create-subject';

type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type Created = Extract<CreateResult, { ok: true }>;

/** The same small initial-terms form is used by the route and its request-backed stories. */
export function CreateSubjectForm({
  locale,
  session,
  transport,
  onNavigate,
  profile,
  onCreated,
}: {
  profile?: {
    title: string;
    scope: string;
    hideHeading?: boolean;
    control?: (pointer: string) => string | undefined;
    errorLabel?: (id: string) => string | undefined;
    type?: string;
    intro?: string;
    href?: string;
    labelLanguage?: (type: string) => string | undefined;
    descriptionLanguage?: (type: string) => string | undefined;
    fields: (type: string, disabled: boolean) => ReactNode;
    prepare: (item: InitialSubject) => { item: InitialSubject; errors: Violation[] };
  };
  locale: string;
  session: Session;
  transport: CreateTransport;
  onNavigate: (href: string) => void;
  onCreated?: (result: Created) => void;
}) {
  const options = { locale: locale as never };
  const client = useQueryClient();
  const queryKey = ['catalogue-create', 'definitions', locale];
  if (profile) queryKey.push(profile.scope);
  // Definitions and the route's session read start independently.
  const definitions = useQuery({ queryKey, queryFn: () => transport.definitions(), retry: false });
  const [type, setType] = useState(profile?.type ?? '');
  const [rows, setRows] = useState<TermDraft[]>([{ language: locale, label: '', description: '', aliases: '' }]);
  const [failure, setFailure] = useState<CreateFailure>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created>();
  const running = useRef(false);
  const unresolvedProfile = useRef(false);
  const request = useRef<CreateSubjectCommand | null>(null);
  const types = definitions.data?.ok
    ? definitions.data.types.filter((entry) => !profile?.type || entry.id === profile.type)
    : [];
  const uncertain =
    (failure?.reason === 'unavailable' && request.current !== null) || (!!profile && unresolvedProfile.current);
  const locked = busy || uncertain || failure?.reason === 'conflict';
  const disabled = locked || session !== 'signed-in';
  const errors = failure?.errors ?? [];

  function control(pointer: string): string {
    const profileControl = profile?.control?.(pointer);
    if (profileControl) return profileControl;
    const [kind, escaped] = pointer.slice(1).split('/');
    if (kind === 'type') return 'create-type';
    const language = escaped?.replaceAll('~1', '/').replaceAll('~0', '~');
    const matches = rows.flatMap((row, index) => (row.language.trim() === language ? [index] : []));
    const index = matches.at(-1) ?? 0;
    const field =
      matches.length > 1 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(rows[index]?.language.trim() ?? '')
        ? 'language'
        : kind === 'descriptions'
          ? 'description'
          : kind === 'aliases'
            ? 'aliases'
            : 'label';
    return `create-${field}-${index}`;
  }
  const invalid = (id: string) => errors.some((error) => control(error.pointer) === id);

  function update(index: number, field: keyof TermDraft, value: string) {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
    setFailure(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current || session !== 'signed-in' || created || failure?.reason === 'conflict') return;
    if (!request.current) {
      const draft = initialTerms(type, rows);
      if (profile) {
        const prepared = profile.prepare(draft.item);
        draft.item = prepared.item;
        draft.errors.push(...prepared.errors);
      }
      if (!types.some((entry) => entry.id === type)) draft.errors.push({ pointer: '/type', code: 'unsupported' });
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      request.current = { item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.submit(request.current);
      if (result.ok) {
        setCreated(result);
        onCreated?.(result);
        if (result.reader.state === 'ready') onNavigate(result.reader.href);
      } else {
        setFailure(result);
        if (profile && result.reason === 'unavailable') unresolvedProfile.current = true;
        // Uncertain delivery and key conflicts retain the exact frozen command. Never silently create a second identity.
        if (!unresolvedProfile.current && result.reason !== 'unavailable' && result.reason !== 'conflict')
          request.current = null;
        if (result.refreshDefinitions) {
          const refreshed = await transport.definitions(true).catch(() => ({ ok: false as const }));
          client.setQueryData(queryKey, refreshed);
        }
      }
    } catch {
      if (profile) unresolvedProfile.current = true;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function openCreated() {
    if (!created || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const reader = await transport.read(created.id);
      setCreated({ ...created, reader });
      onCreated?.({ ...created, reader });
      if (reader.state === 'ready') onNavigate(reader.href);
    } catch {
      setCreated({ ...created, reader: { state: 'unavailable' } });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 text-foreground">
      <header hidden={profile?.hideHeading} className="space-y-3">
        {profile ? (
          <PageHeading>{profile.title}</PageHeading>
        ) : (
          <PageHeading>{m.catalogue_create_title({}, options)}</PageHeading>
        )}
        <p className="text-muted-foreground">{profile?.intro ?? m.catalogue_create_intro({}, options)}</p>
      </header>
      <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
        <p>{m.catalogue_create_duplicate_help({}, options)}</p>
        <a
          className={buttonVariants({ variant: 'outline' })}
          href={`/${locale}/search${rows[0]?.label.trim() ? `?q=${encodeURIComponent(rows[0].label.trim())}` : ''}`}
        >
          {m.catalogue_create_search({}, options)}
        </a>
      </section>
      {created ? (
        <section role="status" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
          <p className="font-medium">{m.catalogue_create_created({}, options)}</p>
          {created.reader.state === 'ready' ? (
            <a href={created.reader.href} className={buttonVariants()}>
              {m.catalogue_create_open({}, options)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, options)
                  : m.catalogue_create_reader_unavailable({}, options)}
              </p>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void openCreated()}>
                {m.catalogue_create_retry({}, options)}
              </Button>
            </>
          )}
        </section>
      ) : (
        <>
          {(session === 'unknown' || definitions.isPending) && (
            <p role="status">{m.catalogue_create_loading({}, options)}</p>
          )}
          {session === 'signed-out' && (
            <p role="status">
              {m.catalogue_create_signed_out({}, options)}{' '}
              <a
                className="underline"
                href={`/auth/sign-in?return_to=${encodeURIComponent(profile?.href ?? `/${locale}/catalogue/new`)}`}
              >
                {m.account_sign_in({}, options)}
              </a>
            </p>
          )}
          {(session === 'unavailable' || definitions.isError || definitions.data?.ok === false) && (
            <div role="alert" className="space-y-3">
              <p>{m.catalogue_create_unavailable({}, options)}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void definitions.refetch();
                  void client.invalidateQueries({ queryKey: ['session'] });
                }}
              >
                {m.catalogue_create_retry({}, options)}
              </Button>
            </div>
          )}
          {!profile && <LiteraryProfileEntry locale={locale} />}
          {!profile && <GameProfileEntry locale={locale} />}
          {!profile && <RecipeEditorEntry locale={locale} />}
          {!profile && <CharacterProfileEntry locale={locale} />}
          {!profile && <MangaProfileEntry locale={locale} />}
          {!profile && <PeopleProfileEntry locale={locale} />}
          {definitions.data?.ok && types.length === 0 && <p role="status">{m.catalogue_create_empty({}, options)}</p>}
          {definitions.data?.ok && types.length > 0 && (
            <form className="space-y-6" noValidate onSubmit={(event) => void submit(event)} aria-busy={busy}>
              <Field hidden={!!profile?.type && profile.hideHeading} data-invalid={invalid('create-type') || undefined}>
                <FieldLabel htmlFor="create-type">{m.catalogue_create_type({}, options)}</FieldLabel>
                <NativeSelect
                  id="create-type"
                  value={type}
                  disabled={disabled}
                  aria-invalid={invalid('create-type')}
                  aria-describedby="create-grain create-type-help"
                  onChange={(event) => {
                    setType(event.target.value);
                    setFailure(undefined);
                  }}
                >
                  <NativeSelectOption value="">{m.catalogue_create_choose_type({}, options)}</NativeSelectOption>
                  {type && !types.some((entry) => entry.id === type) && (
                    <NativeSelectOption value={type} disabled>
                      {m.catalogue_create_choose_type({}, options)}
                    </NativeSelectOption>
                  )}
                  {types.map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id} lang={profile?.labelLanguage?.(entry.id)}>
                      {entry.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription id="create-grain">{m.catalogue_create_grain({}, options)}</FieldDescription>
                <FieldDescription id="create-type-help" lang={profile?.descriptionLanguage?.(type)}>
                  {types.find((entry) => entry.id === type)?.description}
                </FieldDescription>
                <DefinitionGuideLink locale={locale} address={{ type, returnTo: `/${locale}/catalogue/new` }} />
                {invalid('create-type') && <FieldError>{m.catalogue_create_invalid_field({}, options)}</FieldError>}
              </Field>
              {rows.map((row, index) => (
                <fieldset
                  key={index}
                  disabled={disabled}
                  className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
                >
                  <legend className="px-1 text-sm font-semibold">{m.catalogue_create_terms({}, options)}</legend>
                  {(['language', 'label', 'description', 'aliases'] as const).map((field) => {
                    const id = `create-${field}-${index}`;
                    const label =
                      field === 'language'
                        ? m.catalogue_create_language({}, options)
                        : field === 'label'
                          ? m.catalogue_create_label({}, options)
                          : field === 'description'
                            ? m.catalogue_create_description({}, options)
                            : m.catalogue_create_aliases({}, options);
                    return (
                      <Field key={field} data-invalid={invalid(id) || undefined}>
                        <FieldLabel htmlFor={id}>{label}</FieldLabel>
                        {field === 'aliases' ? (
                          <Textarea
                            id={id}
                            value={row[field]}
                            rows={3}
                            aria-invalid={invalid(id)}
                            aria-describedby={`${id}-help`}
                            onChange={(event) => update(index, field, event.target.value)}
                          />
                        ) : (
                          <Input
                            id={id}
                            value={row[field]}
                            maxLength={field === 'language' ? 64 : 250}
                            required={field === 'language' || field === 'label'}
                            aria-invalid={invalid(id)}
                            aria-describedby={field === 'language' ? `${id}-help` : undefined}
                            onChange={(event) => update(index, field, event.target.value)}
                          />
                        )}
                        {field === 'language' && (
                          <FieldDescription id={`${id}-help`}>
                            {m.catalogue_create_language_help({}, options)}
                          </FieldDescription>
                        )}
                        {field === 'aliases' && (
                          <FieldDescription id={`${id}-help`}>
                            {m.catalogue_create_aliases_help({}, options)}
                          </FieldDescription>
                        )}
                        {invalid(id) && <FieldError>{m.catalogue_create_invalid_field({}, options)}</FieldError>}
                      </Field>
                    );
                  })}
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setRows(rows.filter((_, at) => at !== index));
                        setFailure(undefined);
                      }}
                    >
                      {m.catalogue_create_remove_language({}, options)}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => setRows([...rows, { language: '', label: '', description: '', aliases: '' }])}
              >
                {m.catalogue_create_add_language({}, options)}
              </Button>
              {profile?.fields(type, disabled)}
              {failure && (
                <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
                  <p>
                    {failure.reason === 'denied'
                      ? m.catalogue_create_denied({}, options)
                      : failure.reason === 'signed-out'
                        ? m.catalogue_create_signed_out({}, options)
                        : failure.reason === 'conflict'
                          ? m.catalogue_create_conflict({}, options)
                          : failure.reason === 'invalid'
                            ? m.catalogue_create_invalid({}, options)
                            : m.catalogue_create_uncertain({}, options)}
                  </p>
                  {failure.reason === 'signed-out' && (
                    <a
                      className="underline"
                      href={`/auth/sign-in?return_to=${encodeURIComponent(profile?.href ?? `/${locale}/catalogue/new`)}`}
                    >
                      {m.account_sign_in({}, options)}
                    </a>
                  )}
                  {errors.length > 0 && (
                    <ul className="list-inside list-disc">
                      {[...new Set(errors.map((error) => control(error.pointer)))].map((id) => (
                        <li key={id}>
                          {profile?.errorLabel?.(id) ? (
                            <a className="underline" href={`#${id}`}>
                              {profile.errorLabel(id)}
                            </a>
                          ) : (
                            <>
                              <a className="underline" href={`#${id}`}>
                                {profile?.control?.(
                                  errors.find((error) => control(error.pointer) === id)?.pointer ?? '',
                                )
                                  ? errors.find((error) => control(error.pointer) === id)?.pointer
                                  : id === 'create-type'
                                    ? m.catalogue_create_type({}, options)
                                    : id.includes('-language-')
                                      ? m.catalogue_create_language({}, options)
                                      : id.includes('-description-')
                                        ? m.catalogue_create_description({}, options)
                                        : id.includes('-aliases-')
                                          ? m.catalogue_create_aliases({}, options)
                                          : m.catalogue_create_label({}, options)}
                              </a>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, options)}</p>}
                  {failure.reason === 'conflict' && !unresolvedProfile.current && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        request.current = null;
                        setFailure(undefined);
                      }}
                    >
                      {m.catalogue_create_review_new({}, options)}
                    </Button>
                  )}
                </div>
              )}
              <div>
                <Button type="submit" disabled={busy || session !== 'signed-in' || failure?.reason === 'conflict'}>
                  {busy
                    ? m.catalogue_create_saving({}, options)
                    : uncertain
                      ? m.catalogue_create_retry({}, options)
                      : m.catalogue_create_submit({}, options)}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </article>
  );
}
