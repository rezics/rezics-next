import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import { ViewHeadingActions } from '../pages/view-heading';
import { CreateSubjectForm } from './create-subject-form';
import { definitionText } from './definition-guide';
import { EditorFailure, ScalarControl } from './statement-editor-view';
import type { StatementInput } from './statement-editor';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import type { CreateFailure } from './create-subject';
import { peopleInitialItem, peopleProfiles, validatePeopleItem, type PeopleRead, type PeopleTransport } from './people-profile';

type Current = Extract<PeopleRead, { ok: true }>;
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';

function ProfileIntro({ read, locale }: { read: Current; locale: string }) {
  const o = { locale: locale as never };
  const subject = read.public?.subject;
  const profile = read.profiles.find((entry) => entry.id === subject?.type);
  const work = read.work?.subject;
  const workTitle = definitionText(work?.labels, locale);
  return <div className="space-y-3 text-sm">
    <p>{m.people_profile_intro({}, o)}</p>
    {profile && <p lang={profile.descriptionLang ?? undefined}>{profile.description}</p>}
    {subject && <dl className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
      {[...new Set([...Object.keys(subject.labels), ...Object.keys(subject.descriptions), ...Object.keys(subject.aliases)])].map((language) => <div key={language}>
        <dt className="text-muted-foreground">{language}</dt>
        {subject.labels[language] && <dd lang={language} className="break-words font-medium">{subject.labels[language]}</dd>}
        {subject.descriptions[language] && <dd lang={language}>{subject.descriptions[language]}</dd>}
        {!!subject.aliases[language]?.length && <dd lang={language}>{subject.aliases[language]!.join(' · ')}</dd>}
      </div>)}
    </dl>}
    <p className="text-muted-foreground">{m.people_profile_terms({}, o)}</p>
    <p className="text-muted-foreground">{m.people_profile_disclosure({}, o)}</p>
    {work && <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">{m.people_profile_credit({}, o)}</h2>
      <a lang={workTitle.lang ?? undefined} className="underline" href={subjectHref({ id: work.id, label: workTitle.text }, locale).href}>
        {workTitle.text || m.subject_value_unlabelled({}, o)}
      </a>
      <p>{m.people_profile_credit_help({}, o)}</p>
      {read.credits.length ? <a className={buttonVariants({ variant: 'outline' })}
        href={`${subjectHref({ id: work.id, label: workTitle.text }, locale).href}/relation-edit`}>
        {m.relation_title({}, o)}
      </a> : <p role="status">{m.people_profile_no_credit({}, o)}</p>}
    </section>}
  </div>;
}

function PeopleCreate({ initial, locale, session, transport, onNavigate }: {
  initial: Current; locale: string; session: Session; transport: PeopleTransport; onNavigate: (href: string) => void;
}) {
  const o = { locale: locale as never };
  const [read, setRead] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, Record<string, StatementInput>>>({});
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<string>();
  function update(type: string, property: string, statement?: StatementInput) {
    setDrafts((previous) => {
      const fields = { ...previous[type] };
      if (statement) fields[property] = statement;
      else delete fields[property];
      return { ...previous, [type]: fields };
    });
    setFailure(undefined);
  }
  return <section className="mx-auto w-full max-w-3xl space-y-6">
    <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
    <ProfileIntro read={read} locale={locale} />
    {created && <p role="status">{m.people_profile_created_id({}, o)} <code className="break-all">{created}</code></p>}
    <CreateSubjectForm locale={locale} session={session}
    onCreated={(result) => setCreated(result.id)}
    onNavigate={read.work ? () => {} : onNavigate}
    transport={{
      definitions: async (refresh) => {
        const next = refresh ? await transport.load() : read;
        if (!next.ok) return { ok: false };
        if (refresh) setRead(next);
        return { ok: true, types: next.profiles.map(({ id, label, description }) => ({ id, label, description })) };
      },
      submit: async (command) => {
        const result = await transport.create(command);
        setFailure(result.ok ? undefined : result);
        return result;
      },
      read: transport.read,
    }}
    profile={{
      title: m.people_profile_title({}, o),
      hideHeading: true,
      scope: 'people-profile',
      href: `/${locale}/catalogue/people${read.work ? `?work=${encodeURIComponent(read.work.subject.id)}` : ''}`,
      labelLanguage: (type) => read.profiles.find((profile) => profile.id === type)?.lang ?? undefined,
      descriptionLanguage: (type) => read.profiles.find((profile) => profile.id === type)?.descriptionLang ?? undefined,
      control: (pointer) => {
        if (!pointer.startsWith('/statements/')) return undefined;
        const property = pointer.split('/')[2]?.replaceAll('~1', '/').replaceAll('~0', '~');
        return property ? `people-fact-${property}` : undefined;
      },
      prepare: (initial) => {
        const item = peopleInitialItem(initial, drafts[initial.type] ?? {});
        const errors = validatePeopleItem(item, read.release);
        setFailure(errors.length ? { ok: false, reason: 'invalid', errors } : undefined);
        return { item, errors };
      },
      fields: (type, disabled) => {
        const profile = read.profiles.find((entry) => entry.id === type);
        const fields = drafts[type] ?? {};
        return profile && <section className="space-y-4">
          <h2 className="text-xl font-semibold">{m.people_profile_initial({}, o)}</h2>
          <p className="text-sm text-muted-foreground">{m.people_profile_initial_help({}, o)}</p>
          <p lang={profile.descriptionLang ?? undefined}>{profile.description}</p>
          <div className="flex flex-wrap gap-2">
            {profile.fields.filter((id) => !fields[id]).map((id) => {
              const name = definitionText(read.release.properties[id]?.labels, locale);
              return <Button key={id} type="button" variant="outline" disabled={disabled} onClick={() => update(type, id, {
                property: { id }, value: { type: 'value', content: '' }, qualifiers: [], references: [], rank: 'normal',
              })}><span lang={name.lang ?? undefined}>{m.people_profile_add_fact({ field: name.text }, o)}</span></Button>;
            })}
          </div>
          {Object.entries(fields).map(([property, statement]) => {
            const name = definitionText(read.release.properties[property]?.labels, locale);
            const supported = profile.fields.includes(property);
            const citation = statement.references[0]?.parts[0]?.value;
            const pointer = `/statements/${property.replaceAll('~', '~0').replaceAll('/', '~1')}`;
            const invalid = failure?.errors?.some((error) => error.pointer === pointer || error.pointer.startsWith(`${pointer}/`));
            return <fieldset key={property} id={`people-fact-${property}`} disabled={disabled} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <legend className="px-1 font-medium" lang={name.lang ?? undefined}>{name.text || m.candidate_value_unavailable({}, o)}</legend>
              {supported ? <ScalarControl part={statement} definition={read.release.properties[property]}
                read={{ release: read.release, public: { related: {} } }} locale={locale}
                onChange={(value) => update(type, property, { ...statement, value })} />
                : <EditorFailure reason="stale" locale={locale} />}
              <Field>
                <FieldLabel htmlFor={`people-citation-${property}`}>{m.relation_citation({}, o)}</FieldLabel>
                <Input id={`people-citation-${property}`} type="url" value={citation?.type === 'value' ? String(citation.content) : ''}
                  onChange={(event) => update(type, property, { ...statement, references: event.target.value.trim() ? [{ parts: [{
                    property: { id: 'schema:url' }, value: { type: 'value', content: event.target.value },
                  }] }] : [] })} />
              </Field>
              {invalid && <FieldError>{m.catalogue_create_invalid_field({}, o)}</FieldError>}
              <Button type="button" variant="ghost" onClick={() => update(type, property)}>{m.people_profile_remove_fact({}, o)}</Button>
            </fieldset>;
          })}
          {!!profile.unsupported.length && <p className="text-sm text-muted-foreground">{m.people_profile_unsupported({}, o)}{' '}
            {profile.unsupported.map((id) => {
              const name = definitionText(read.release.properties[id]?.labels, locale);
              return <span key={id} className="me-2" lang={name.lang ?? undefined}>{name.text}</span>;
            })}
          </p>}
        </section>;
      },
    }}
  /></section>;
}

/** One guided surface composed from the existing creation, multi-field and exact native review controls. */
export function PeopleProfileEditor({ id, work, locale, session, transport, propose, review, relations, onNavigate }: {
  id?: string; work?: string; locale: string; session: Session; transport: PeopleTransport;
  propose: FactsTransport['propose'];
  review: (property: string, session?: string) => CandidateTransport;
  relations?: ReactNode;
  onNavigate: (href: string) => void;
}) {
  const o = { locale: locale as never };
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['people-profile', id ?? 'new', work ?? '', locale], queryFn: transport.load, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity });
  const read = query.data;
  if (!read?.ok) return <article className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
    {query.isPending ? <p role="status">{m.catalogue_create_loading({}, o)}</p> : <>
      <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
      <Button type="button" variant="outline" onClick={() => void query.refetch()}>{m.catalogue_create_retry({}, o)}</Button>
    </>}
  </article>;
  if (!id) return <PeopleCreate initial={read} locale={locale} session={session} transport={transport} onNavigate={onNavigate} />;
  if (session !== 'signed-in') return <article className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
    <ProfileIntro read={read} locale={locale} />
    <p role="status">{session === 'signed-out' ? m.catalogue_create_signed_out({}, o)
      : session === 'unavailable' ? m.catalogue_create_unavailable({}, o) : m.catalogue_create_loading({}, o)}</p>
    {session === 'unavailable' && <Button type="button" variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ['session'] })}>
      {m.catalogue_create_retry({}, o)}
    </Button>}
    {session === 'signed-out' && <a className="underline" href={`/auth/sign-in?return_to=${encodeURIComponent(id && read.public
      ? `${subjectHref({ id, label: definitionText(read.public.subject.labels, locale).text }, locale).href}/people`
      : `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`)}`}>
      {m.account_sign_in({}, o)}
    </a>}
  </article>;
  if (!read.public) return <EditorFailure reason="unavailable" locale={locale} />;
  return <SubjectFacts locale={locale} initial={{ ok: true, public: read.public, release: read.release, source: null }}
    profile={{ title: m.people_profile_title({}, o), intro: m.facts_intro({}, o), empty: m.facts_empty({}, o), path: 'people',
      properties: (current) => peopleProfiles(current.release, locale)
        .find((profile) => profile.id === current.public.subject.type)?.fields ?? [],
    }}
    profileIntro={<ProfileIntro read={read} locale={locale} />}
    profileRelations={relations}
    transport={{ propose, read: async () => {
      const next = await transport.load();
      return next.ok && next.public ? { ok: true, public: next.public, release: next.release, source: null }
        : next.ok ? { ok: false, reason: 'unavailable' } : next;
    } }} review={review} />;
}
