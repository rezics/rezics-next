import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useRef, useState, type FormEvent } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CreateFailure, CreateResult } from './create-subject';
import {
  publicationDraft,
  publicationTarget,
  type PublicationCommand,
  type PublicationTransport,
} from './publication-editor';
import { ScalarControl } from './statement-editor-view';
import type { SnakInput } from './statement-editor';

/** Ordinary initial facts for one independently identified publication, anchored to an existing work. */
export function PublicationEditor({
  work,
  locale,
  session,
  transport,
  search,
  onNavigate,
}: {
  work: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: PublicationTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
}) {
  const o = { locale: locale as never };
  // Session and the independent public work/definition reads start together.
  const query = useQuery({
    queryKey: ['publication-editor', work, locale],
    queryFn: () => transport.load(),
    retry: false,
  });
  const read = query.data?.ok ? query.data : undefined;
  const profile = read?.profiles[0];
  const [relationChoice, setRelation] = useState('');
  const relation = relationChoice || profile?.relations[0] || '';
  const [language, setLanguage] = useState(locale);
  const [label, setLabel] = useState('');
  const [facts, setFacts] = useState<Record<string, SnakInput['value']>>({});
  const [publisher, setPublisher] = useState<EntityPickerSubject[]>([]);
  const [field, setField] = useState('');
  const [citation, setCitation] = useState('');
  const [independent, setIndependent] = useState(false);
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const command = useRef<PublicationCommand | null>(null);
  const uncertain = failure?.reason === 'unavailable' && command.current !== null;
  const locked = busy || uncertain || failure?.reason === 'conflict';
  const disabled = locked || session !== 'signed-in';
  const name = (id: string) => pickText(read?.release.properties[id]?.labels ?? {}, locale).text;
  const title = read ? pickText(read.public.subject.labels, locale).text : '';
  const back = read ? subjectHref({ id: work, label: title }, locale).href : `/${locale}/search`;

  function edit(change: () => void) {
    change();
    // Only an explicit edit after a definite refusal starts a different request. Uncertain drafts stay frozen.
    command.current = null;
    setFailure(undefined);
  }
  const invalid = (pointer: string) => failure?.errors?.some((error) => error.pointer.startsWith(pointer)) === true;
  function errorControl(pointer: string) {
    if (pointer.includes('/references/')) return { id: 'publication-citation', label: m.relation_citation({}, o) };
    if (pointer.startsWith('/statements/')) {
      const property = pointer.split('/')[2] ?? '';
      return property === relation
        ? { id: 'publication-relation', label: m.relation_property({}, o) }
        : {
            id: `publication-fact-${property.replaceAll(':', '-')}`,
            label: name(property) || m.publication_field({}, o),
          };
    }
    if (pointer === '/independent') return { id: 'publication-independent', label: m.publication_independent({}, o) };
    if (pointer === '/type' || pointer === '/relation')
      return { id: 'publication-relation', label: m.relation_property({}, o) };
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language.trim()))
      return { id: 'publication-language', label: m.catalogue_create_language({}, o) };
    return { id: 'publication-label', label: m.catalogue_create_label({}, o) };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running.current || created || !read || !profile || session !== 'signed-in' || failure?.reason === 'conflict')
      return;
    if (!command.current) {
      const draft = publicationDraft(
        read,
        profile.id,
        relation,
        [{ language, label, description: '', aliases: '' }],
        facts,
        citation,
        independent,
      );
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      command.current = { work, relation, item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.submit(command.current);
      if (result.ok) {
        setCreated(result);
        if (result.reader.state === 'ready') onNavigate(result.reader.href);
      } else {
        setFailure(result);
        if (result.refreshDefinitions) await query.refetch();
      }
    } catch {
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
      <header className="space-y-3">
        <PageHeading>{m.publication_add({}, o)}</PageHeading>
        <p className="text-muted-foreground">{m.publication_intro({}, o)}</p>
      </header>
      {created ? (
        <section role="status" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
          <p>{m.catalogue_create_created({}, o)}</p>
          {created.reader.state === 'ready' ? (
            <a href={created.reader.href} className={buttonVariants()}>
              {m.catalogue_create_open({}, o)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
              </p>
              <Button variant="outline" disabled={busy} onClick={() => void openCreated()}>
                {m.catalogue_create_retry({}, o)}
              </Button>
            </>
          )}
        </section>
      ) : (
        <>
          {query.isPending && <p role="status">{m.catalogue_create_loading({}, o)}</p>}
          {(query.isError || query.data?.ok === false) && (
            <div role="alert" className="space-y-3">
              <p>
                {query.data?.ok === false && query.data.reason === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : query.data?.ok === false && query.data.reason === 'invalid'
                    ? m.publication_missing_work({}, o)
                    : m.catalogue_create_unavailable({}, o)}
              </p>
              {query.data?.ok === false && query.data.reason === 'invalid' ? (
                <a href={`/${locale}/search`} className={buttonVariants({ variant: 'outline' })}>
                  {m.catalogue_create_search({}, o)}
                </a>
              ) : (
                <Button variant="outline" onClick={() => void query.refetch()}>
                  {m.catalogue_create_retry({}, o)}
                </Button>
              )}
            </div>
          )}
          {read && (
            <>
              <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
                <p className="text-sm text-muted-foreground">{m.publication_work({}, o)}</p>
                <a href={back} className="font-medium underline">
                  {title || m.subject_value_unlabelled({}, o)}
                </a>
                <p>{m.publication_duplicate({}, o)}</p>
                <a
                  href={`/${locale}/search?q=${encodeURIComponent(label.trim() || title)}`}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {m.publication_search({}, o)}
                </a>
              </section>
              {!profile ? (
                <p role="status">{m.publication_empty({}, o)}</p>
              ) : (
                <form onSubmit={(event) => void submit(event)} noValidate className="space-y-6" aria-busy={busy}>
                  {session === 'unknown' && <p role="status">{m.catalogue_create_loading({}, o)}</p>}
                  {session === 'unavailable' && <p role="alert">{m.catalogue_create_unavailable({}, o)}</p>}
                  {session === 'signed-out' && (
                    <p>
                      {m.catalogue_create_signed_out({}, o)}{' '}
                      <a
                        className="underline"
                        href={`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/catalogue/publication?work=${work}`)}`}
                      >
                        {m.account_sign_in({}, o)}
                      </a>
                    </p>
                  )}
                  <fieldset disabled={disabled} className="min-w-0 space-y-4">
                    <legend lang={profile.labelLang ?? undefined} className="mb-4 font-semibold">
                      {profile.label}
                    </legend>
                    {profile.description && (
                      <p lang={profile.descriptionLang ?? undefined} className="text-sm text-muted-foreground">
                        {profile.description}
                        {profile.descriptionLang && profile.descriptionLang !== locale && (
                          <span lang={locale} className="ms-2">
                            {m.guide_fallback({ language: profile.descriptionLang }, o)}
                          </span>
                        )}
                      </p>
                    )}
                    <Field data-invalid={invalid('/labels') || undefined}>
                      <FieldLabel htmlFor="publication-label">{m.catalogue_create_label({}, o)}</FieldLabel>
                      <Input
                        id="publication-label"
                        value={label}
                        required
                        maxLength={250}
                        aria-invalid={invalid('/labels')}
                        onChange={(e) => edit(() => setLabel(e.target.value))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="publication-language">{m.catalogue_create_language({}, o)}</FieldLabel>
                      <Input
                        id="publication-language"
                        value={language}
                        maxLength={64}
                        aria-describedby="publication-language-help"
                        onChange={(e) => edit(() => setLanguage(e.target.value))}
                      />
                      <FieldDescription id="publication-language-help">
                        {m.catalogue_create_language_help({}, o)}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="publication-relation">{m.relation_property({}, o)}</FieldLabel>
                      <NativeSelect
                        id="publication-relation"
                        value={relation}
                        onChange={(e) => edit(() => setRelation(e.target.value))}
                      >
                        {profile.relations.map((id) => (
                          <NativeSelectOption key={id} value={id}>
                            {name(id)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field orientation="horizontal" data-invalid={invalid('/independent') || undefined}>
                      <Checkbox
                        id="publication-independent"
                        checked={independent}
                        aria-invalid={invalid('/independent')}
                        onCheckedChange={(value) => edit(() => setIndependent(value))}
                      />
                      <FieldLabel htmlFor="publication-independent">{m.publication_independent({}, o)}</FieldLabel>
                    </Field>
                  </fieldset>
                  {Object.entries(facts).map(([property, value]) => (
                    <fieldset
                      key={property}
                      id={`publication-fact-${property.replaceAll(':', '-')}`}
                      disabled={disabled}
                      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6"
                    >
                      <legend className="px-1 text-sm font-semibold">
                        {name(property) || m.correction_preserved({}, o)}
                      </legend>
                      {property === 'schema:publisher' ? (
                        <EntityPicker
                          label={name(property)}
                          value={publisher}
                          search={async (text, signal) =>
                            (await search(text, signal)).filter((item) =>
                              item.types.some((type) => publicationTarget(read.release, type, property)),
                            )
                          }
                          src={coverSrc}
                          disabled={disabled}
                          onValueChange={(items) =>
                            edit(() => {
                              setPublisher(items);
                              setFacts({ ...facts, [property]: { type: 'value', content: items[0]?.id ?? '' } });
                            })
                          }
                        />
                      ) : (
                        <ScalarControl
                          part={{ property: { id: property }, value }}
                          definition={read.release.properties[property]}
                          read={read}
                          locale={locale}
                          onChange={(next) => edit(() => setFacts({ ...facts, [property]: next }))}
                        />
                      )}
                      {invalid(`/statements/${property}`) && (
                        <FieldError>{m.catalogue_create_invalid_field({}, o)}</FieldError>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          edit(() => {
                            setFacts(Object.fromEntries(Object.entries(facts).filter(([id]) => id !== property)));
                            if (property === 'schema:publisher') setPublisher([]);
                          })
                        }
                      >
                        {m.relation_remove({}, o)}
                      </Button>
                    </fieldset>
                  ))}
                  <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-end gap-3">
                    <Field className="min-w-0 flex-1">
                      <FieldLabel htmlFor="publication-field">{m.publication_field({}, o)}</FieldLabel>
                      <NativeSelect id="publication-field" value={field} onChange={(e) => setField(e.target.value)}>
                        <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                        {profile.fields
                          .filter((id) => !Object.hasOwn(facts, id))
                          .map((id) => (
                            <NativeSelectOption key={id} value={id}>
                              {name(id)}
                            </NativeSelectOption>
                          ))}
                      </NativeSelect>
                    </Field>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!field}
                      onClick={() =>
                        edit(() => {
                          const datatype = read.release.properties[field]?.datatype;
                          setFacts({
                            ...facts,
                            [field]: {
                              type: 'value',
                              content: datatype === 'time' || datatype === 'quantity' ? {} : '',
                            },
                          });
                          setField('');
                        })
                      }
                    >
                      {m.correction_add({}, o)}
                    </Button>
                  </fieldset>
                  {read.release.properties['schema:url'] && (
                    <fieldset disabled={disabled}>
                      <Field>
                        <FieldLabel htmlFor="publication-citation">{m.relation_citation({}, o)}</FieldLabel>
                        <Input
                          id="publication-citation"
                          type="url"
                          value={citation}
                          maxLength={1500}
                          onChange={(e) => edit(() => setCitation(e.target.value))}
                        />
                        <FieldDescription>{m.publication_citation({}, o)}</FieldDescription>
                      </Field>
                    </fieldset>
                  )}
                  {failure && (
                    <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
                      <p>
                        {failure.reason === 'denied'
                          ? m.catalogue_create_denied({}, o)
                          : failure.reason === 'signed-out'
                            ? m.catalogue_create_signed_out({}, o)
                            : failure.reason === 'conflict'
                              ? m.catalogue_create_conflict({}, o)
                              : failure.reason === 'invalid'
                                ? m.catalogue_create_invalid({}, o)
                                : m.catalogue_create_uncertain({}, o)}
                      </p>
                      {failure.errors?.length ? (
                        <ul className="list-inside list-disc">
                          {[
                            ...new Map(
                              failure.errors.map((error) => {
                                const control = errorControl(error.pointer);
                                return [control.id, control] as const;
                              }),
                            ).values(),
                          ].map((control) => (
                            <li key={control.id}>
                              <a className="underline" href={`#${control.id}`}>
                                {control.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
                      {failure.reason === 'conflict' && (
                        <Button type="button" variant="outline" onClick={() => edit(() => {})}>
                          {m.catalogue_create_review_new({}, o)}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" disabled={busy || session !== 'signed-in' || failure?.reason === 'conflict'}>
                      {busy
                        ? m.catalogue_create_saving({}, o)
                        : uncertain
                          ? m.catalogue_create_retry({}, o)
                          : m.publication_submit({}, o)}
                    </Button>
                    <a href={back} className={buttonVariants({ variant: 'outline' })}>
                      {m.publication_back({}, o)}
                    </a>
                  </div>
                </form>
              )}
            </>
          )}
        </>
      )}
    </article>
  );
}
