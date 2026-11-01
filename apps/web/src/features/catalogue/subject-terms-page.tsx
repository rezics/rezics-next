import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { pickText } from '@rezics/composition';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { termsFieldGuidance } from './subject-terms-guidance';
import {
  hasTermsPatch,
  languageDraft,
  termFields,
  termsPatch,
  type LanguageDraft,
  type TermField,
  type TermsCommand,
  type TermsDraft,
  type TermsFailure,
  type TermsRead,
  type TermsResult,
  type TermsSnapshot,
  type TermsTransport,
} from './subject-terms';

// Keep dense fine-pointer controls while allowing translated actions to grow onto multiple lines.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-h-11 md:pointer-fine:min-h-8';
// NativeSelect applies className to its wrapper; enlarge the actual select inside it.
const selectClassName = 'min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm underline [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';

export function SubjectTermsPage({
  id,
  locale,
  session,
  transport,
  typeLabels,
}: {
  id: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: TermsTransport;
  typeLabels?: Record<string, string>;
}) {
  const options = { locale: locale as never };
  const query = useQuery({
    queryKey: ['catalogue-terms', id, locale],
    queryFn: () => transport.read(id),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [language, setLanguage] = useState(locale);
  const [newLanguage, setNewLanguage] = useState('');
  const [languageError, setLanguageError] = useState(false);
  const [drafts, setDrafts] = useState<TermsDraft>({});
  const [failure, setFailure] = useState<TermsFailure>();
  const [comparison, setComparison] = useState<TermsRead>();
  const [saved, setSaved] = useState<Extract<TermsResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const pending = useRef<TermsCommand | null>(null);
  const base =
    saved?.reader.state === 'ready'
      ? saved.reader.snapshot
      : query.data?.state === 'ready'
        ? query.data.snapshot
        : undefined;
  const uncertain = failure?.reason === 'unavailable' && pending.current !== null;
  const stale = failure?.reason === 'stale' || failure?.reason === 'conflict';
  const locked = busy || uncertain || stale || !!saved || session !== 'signed-in';
  const fieldLabel = (field: TermField) =>
    field === 'labels'
      ? m.catalogue_create_label({}, options)
      : field === 'descriptions'
        ? m.catalogue_create_description({}, options)
        : m.catalogue_create_aliases({}, options);
  const failureText = (reason: TermsFailure['reason']) =>
    reason === 'stale'
      ? m.catalogue_terms_stale({}, options)
      : reason === 'conflict'
        ? m.catalogue_terms_conflict({}, options)
        : reason === 'denied'
          ? m.catalogue_terms_denied({}, options)
          : reason === 'concealed'
            ? m.catalogue_create_concealed({}, options)
            : reason === 'signed-out'
              ? m.catalogue_create_signed_out({}, options)
              : reason === 'invalid'
                ? m.catalogue_create_invalid({}, options)
                : m.catalogue_terms_uncertain({}, options);

  function update(field: TermField, edit: Partial<LanguageDraft[TermField]>) {
    if (!base || locked) return;
    setDrafts((previous) => {
      const current = previous[language] ?? languageDraft(base.subject, language);
      return { ...previous, [language]: { ...current, [field]: { ...current[field], ...edit } } };
    });
    setFailure(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>, confirmed?: TermsSnapshot) {
    event.preventDefault();
    if (!base || running.current || saved || session !== 'signed-in' || (stale && !confirmed)) return;
    const snapshot = confirmed ?? base;
    if (!pending.current || confirmed) {
      const draft = termsPatch(snapshot.subject, drafts);
      if (draft.errors.length || !hasTermsPatch(draft.patch)) {
        if (confirmed) pending.current = null;
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      pending.current = {
        id: snapshot.subject.id,
        etag: snapshot.etag,
        key: crypto.randomUUID(),
        patch: draft.patch,
        ...(snapshot.session ? { session: snapshot.session } : {}),
      };
    }
    running.current = true;
    setBusy(true);
    setComparison(undefined);
    setFailure(undefined);
    try {
      const result = await transport.submit(pending.current);
      if (result.ok) {
        setSaved(result);
        pending.current = null;
      } else {
        setFailure(result);
        if (!['unavailable', 'stale', 'conflict'].includes(result.reason)) pending.current = null;
      }
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function reread() {
    if (!base || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = saved ? await transport.read(saved.id, saved.session) : await transport.read(id, base.session);
      if (saved) setSaved({ ...saved, reader: result });
      else setComparison(result);
    } catch {
      if (saved) setSaved({ ...saved, reader: { state: 'unavailable' } });
      else setComparison({ state: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function values(snapshot: TermsSnapshot, languages: string[]) {
    return (
      <dl className="space-y-3 break-words">
        {languages.map((tag) => (
          <div key={tag} className="space-y-1">
            <dt className="font-medium">{tag}</dt>
            {termFields.map((field) => (
              <dd key={field} className="text-sm">
                <span className="text-muted-foreground">{fieldLabel(field)}: </span>
                <span lang={tag} className="whitespace-pre-wrap">
                  {termValue(snapshot, field, tag) || m.catalogue_terms_absent({}, options)}
                </span>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    );
  }

  const languages = [
    ...new Set([
      locale,
      language,
      ...Object.keys(drafts),
      ...termFields.flatMap((field) => Object.keys(base?.subject[field] ?? {})),
    ]),
  ];
  const row = base ? (drafts[language] ?? languageDraft(base.subject, language)) : undefined;
  const typeLabel = base ? typeLabels?.[base.subject.type] : undefined;
  const errors = failure?.errors ?? [];
  const guidance = (field: TermField) => (row ? termsFieldGuidance(errors, field, language, row[field], locale) : []);

  return (
    <article className="mx-auto min-w-0 w-full max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-3">
        <PageHeading>{m.catalogue_terms_title({}, options)}</PageHeading>
        {base && (
          <p className="break-words font-medium">
            {pickText(base.subject.labels, locale).text || m.subject_value_unlabelled({}, options)}
            {typeLabel && <span className="ml-3 text-sm text-muted-foreground">{typeLabel}</span>}
          </p>
        )}
        <p className="text-muted-foreground">{m.catalogue_terms_intro({}, options)}</p>
        {base && !saved && (
          <a className={linkClassName} href={base.href}>
            {m.catalogue_create_open({}, options)}
          </a>
        )}
      </header>
      {query.isPending && <p role="status">{m.candidate_loading({}, options)}</p>}
      {!base && !query.isPending && (
        <section role="alert" className="space-y-3">
          <p>
            {query.data?.state === 'concealed'
              ? m.catalogue_create_concealed({}, options)
              : query.data?.state === 'denied'
                ? m.catalogue_result_read_denied({}, options)
                : m.catalogue_result_read_unavailable({}, options)}
          </p>
          <Button className={actionClassName} variant="outline" onClick={() => void query.refetch()}>
            {m.catalogue_retry_loading_result({}, options)}
          </Button>
        </section>
      )}
      {base && row && (
        <>
          {session !== 'signed-in' && (
            <p role="status">
              {session === 'signed-out'
                ? m.catalogue_create_signed_out({}, options)
                : session === 'unavailable'
                  ? m.catalogue_create_unavailable({}, options)
                  : m.catalogue_create_loading({}, options)}
              {session === 'signed-out' && (
                <>
                  {' '}
                  <a
                    className={linkClassName}
                    href={`/auth/sign-in?return_to=${encodeURIComponent(`${base.href}/terms`)}`}
                  >
                    {m.account_sign_in({}, options)}
                  </a>
                </>
              )}
            </p>
          )}
          {saved ? (
            <section role="status" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
              <p className="font-medium">{m.catalogue_terms_saved({}, options)}</p>
              {saved.reader.state === 'ready' ? (
                <>
                  {values(saved.reader.snapshot, termLanguages(saved.reader.snapshot))}
                  <a className={buttonVariants({ className: actionClassName })} href={saved.reader.snapshot.href}>
                    {m.catalogue_create_open({}, options)}
                  </a>
                </>
              ) : (
                <>
                  <p>
                    {saved.reader.state === 'concealed'
                      ? m.catalogue_create_concealed({}, options)
                      : saved.reader.state === 'denied'
                        ? m.catalogue_result_read_denied({}, options)
                        : m.catalogue_terms_reader_unavailable({}, options)}
                  </p>
                  <Button className={actionClassName} disabled={busy} onClick={() => void reread()}>
                    {m.catalogue_retry_loading_result({}, options)}
                  </Button>
                </>
              )}
            </section>
          ) : (
            <form
              className="space-y-6"
              noValidate
              aria-busy={busy}
              onSubmit={(event) => void submit(event, comparison?.state === 'ready' ? comparison.snapshot : undefined)}
            >
              <Field>
                <FieldLabel htmlFor="terms-language">{m.catalogue_create_language({}, options)}</FieldLabel>
                <NativeSelect
                  className={selectClassName}
                  id="terms-language"
                  aria-describedby="terms-language-help"
                  value={language}
                  disabled={busy}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  {languages.map((tag) => (
                    <NativeSelectOption key={tag} value={tag}>
                      {tag}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription id="terms-language-help">
                  {m.catalogue_create_language_help({}, options)}
                </FieldDescription>
              </Field>
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
                <Field className="min-w-0 flex-1">
                  <FieldLabel htmlFor="terms-new-language">{m.catalogue_terms_new_language({}, options)}</FieldLabel>
                  <Input
                    className={inputClassName}
                    id="terms-new-language"
                    value={newLanguage}
                    disabled={locked}
                    maxLength={64}
                    aria-invalid={languageError}
                    aria-describedby={languageError ? 'terms-new-language-error' : undefined}
                    onChange={(event) => {
                      setNewLanguage(event.target.value);
                      setLanguageError(false);
                    }}
                  />
                  {languageError && (
                    <FieldError id="terms-new-language-error">
                      {m.catalogue_terms_validation_language({}, options)}
                    </FieldError>
                  )}
                </Field>
                <Button
                  className={actionClassName}
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() => {
                    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(newLanguage)) {
                      setLanguageError(true);
                      return;
                    }
                    setLanguage(newLanguage);
                    setNewLanguage('');
                  }}
                >
                  {m.catalogue_create_add_language({}, options)}
                </Button>
              </div>
              {!termFields.some((field) => Object.hasOwn(base.subject[field], language)) && (
                <p role="status">{m.catalogue_terms_empty({}, options)}</p>
              )}
              {termFields.map((field) => {
                const messages = guidance(field);
                const invalid = messages.length > 0;
                const errorId = invalid ? `terms-${field}-error` : undefined;
                return (
                  <fieldset
                    key={field}
                    disabled={locked}
                    className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6"
                  >
                    <legend className="px-1 text-sm font-semibold">{fieldLabel(field)}</legend>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      <span className="text-muted-foreground">{m.catalogue_terms_original({}, options)}: </span>
                      <span lang={language}>
                        {termValue(base, field, language) || m.catalogue_terms_absent({}, options)}
                      </span>
                    </p>
                    <Field>
                      <FieldLabel htmlFor={`terms-${field}-mode`}>{m.catalogue_terms_action({}, options)}</FieldLabel>
                      <NativeSelect
                        className={selectClassName}
                        id={`terms-${field}-mode`}
                        value={row[field].mode}
                        aria-invalid={invalid}
                        aria-describedby={errorId}
                        onChange={(event) =>
                          update(field, { mode: event.target.value as LanguageDraft[TermField]['mode'] })
                        }
                      >
                        <NativeSelectOption value="keep">{m.catalogue_terms_keep({}, options)}</NativeSelectOption>
                        <NativeSelectOption value="set">{m.catalogue_terms_replace({}, options)}</NativeSelectOption>
                        <NativeSelectOption value="remove">{m.catalogue_terms_remove({}, options)}</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    {row[field].mode === 'set' && (
                      <Field data-invalid={invalid || undefined}>
                        <FieldLabel htmlFor={`terms-${field}`}>{fieldLabel(field)}</FieldLabel>
                        {field === 'aliases' ? (
                          <Textarea
                            id={`terms-${field}`}
                            lang={language}
                            value={row[field].value}
                            rows={3}
                            aria-invalid={invalid}
                            aria-describedby={['terms-aliases-help', errorId].filter(Boolean).join(' ')}
                            onChange={(event) => update(field, { value: event.target.value })}
                          />
                        ) : (
                          <Input
                            className={inputClassName}
                            id={`terms-${field}`}
                            lang={language}
                            value={row[field].value}
                            maxLength={250}
                            aria-invalid={invalid}
                            aria-describedby={errorId}
                            onChange={(event) => update(field, { value: event.target.value })}
                          />
                        )}
                        {field === 'aliases' && (
                          <FieldDescription id="terms-aliases-help">
                            {m.catalogue_terms_alias_limits({}, options)}
                          </FieldDescription>
                        )}
                      </Field>
                    )}
                    {invalid && <FieldError id={errorId} errors={messages.map((message) => ({ message }))} />}
                  </fieldset>
                );
              })}
              {failure && (
                <section role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
                  <p>{failureText(failure.reason)}</p>
                  {failure.detail && <p>{failure.detail}</p>}
                  {failure.reason === 'denied' && base.profileHref && (
                    <a href={base.profileHref} className={linkClassName}>
                      {m.catalogue_terms_profile({}, options)}
                    </a>
                  )}
                  {stale && (
                    <Button
                      className={actionClassName}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void reread()}
                    >
                      {m.catalogue_terms_compare({}, options)}
                    </Button>
                  )}
                </section>
              )}
              {comparison && (
                <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6" aria-live="polite">
                  <h2 className="font-semibold">{m.catalogue_terms_latest({}, options)}</h2>
                  {comparison.state === 'ready' ? (
                    <>
                      {values(comparison.snapshot, [
                        ...new Set([
                          ...languages,
                          ...termFields.flatMap((field) => Object.keys(comparison.snapshot.subject[field])),
                        ]),
                      ])}
                      <p>{m.catalogue_terms_confirm_help({}, options)}</p>
                    </>
                  ) : (
                    <p>
                      {comparison.state === 'concealed'
                        ? m.catalogue_create_concealed({}, options)
                        : comparison.state === 'denied'
                          ? m.catalogue_result_read_denied({}, options)
                          : m.catalogue_result_read_unavailable({}, options)}
                    </p>
                  )}
                </section>
              )}
              <Button
                className={actionClassName}
                type="submit"
                disabled={busy || session !== 'signed-in' || (stale && comparison?.state !== 'ready')}
              >
                {busy
                  ? m.correction_saving({}, options)
                  : uncertain
                    ? m.catalogue_create_retry({}, options)
                    : comparison?.state === 'ready'
                      ? m.catalogue_terms_confirm({}, options)
                      : m.catalogue_terms_save({}, options)}
              </Button>
            </form>
          )}
        </>
      )}
    </article>
  );
}

function termValue(snapshot: TermsSnapshot, field: TermField, language: string): string {
  const value = snapshot.subject[field][language];
  return Array.isArray(value) ? value.join('\n') : (value ?? '');
}

function termLanguages(snapshot: TermsSnapshot): string[] {
  return [...new Set(termFields.flatMap((field) => Object.keys(snapshot.subject[field])))];
}
