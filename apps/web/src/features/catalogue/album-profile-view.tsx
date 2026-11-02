import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import type { CandidateTransport } from '../../subject/candidate-review';
import { relationFields, type RelationTransport } from '../../subject/relation-candidates';
import { subjectHref } from '../../subject/subject-href';
import { albumFields, albumType, type AlbumTransport } from './album-profile';
import { AlbumProfileCreate } from './album-profile-create';
import { DefinitionMeaning } from './definition-meaning';
import { AuthoredFieldEntry } from './authored-field-entry';
import { DefinitionGuideLink } from './definition-guide-view';
import { RelationEditor } from './relation-editor';
import { EditorFailure, PartValue } from './statement-editor-view';
import { ExactReview, FactField, SelectedFacts } from './subject-facts-view';
import {
  factChanged,
  factLimit,
  sealFacts,
  sendFacts,
  stageFact,
  type FactDraft,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { SubjectTermsEntry } from './subject-terms-entry';

export type AlbumEditors = {
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations: RelationTransport;
  onSelected?: () => void | Promise<void>;
};

export const AlbumProfile = catalogueEditor(AlbumProfileLive);

function AlbumProfileLive({
  id,
  locale,
  session,
  transport,
  search,
  editors,
}: {
  id?: string;
  locale: string;
  session: string;
  transport: AlbumTransport;
  search: EntityPickerSearch;
  editors?: AlbumEditors;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['album-profile', id, locale], lifetime.generation],
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = query.data?.ok ? query.data : undefined;
  const admitted = !!read?.release.types[albumType];
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header className="space-y-3">
        <PageHeading className="font-sans">{id ? m.album_edit({}, o) : m.album_title({}, o)}</PageHeading>
        {!id && <p className="max-w-prose text-muted-foreground">{m.album_grain({}, o)}</p>}
        {read && !id && (
          <div className="flex flex-wrap items-center gap-3">
            <DefinitionMeaning values={read.release.types[albumType]?.labels} locale={locale} />
            <DefinitionGuideLink
              locale={locale}
              address={{
                type: albumType,
                returnTo:
                  id && read.public
                    ? `${subjectHref({ id, label: pickText(read.public.subject.labels, locale).text }, locale).href}/album`
                    : `/${locale}/catalogue/album`,
              }}
            />
          </div>
        )}
      </header>
      {!id && <p className="text-sm text-muted-foreground">{m.album_scope({}, o)}</p>}
      {session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.catalogue_create_unavailable({}, o)
              : m.candidate_loading({}, o)}
        </p>
      )}
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || (query.data && !query.data.ok)) && (
        <div className="space-y-3">
          {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
            <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
          ) : (
            <EditorFailure reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} locale={locale} />
          )}
          <Button onClick={() => void query.refetch()}>{m.correction_retry({}, o)}</Button>
        </div>
      )}
      {read && !admitted && <p role="status">{m.album_missing({}, o)}</p>}
      {read &&
        admitted &&
        (!id ? (
          <AlbumProfileCreate
            release={read.release}
            locale={locale}
            transport={transport}
            search={search}
            enabled={session === 'signed-in'}
          />
        ) : read.public && editors ? (
          <AlbumCorrections
            initial={{ ...read, public: read.public, source: null }}
            locale={locale}
            enabled={session === 'signed-in'}
            search={search}
            editors={editors}
          />
        ) : (
          <EditorFailure reason="unavailable" locale={locale} />
        ))}
    </article>
  );
}

function AlbumCorrections({
  initial,
  locale,
  enabled,
  search,
  editors,
}: {
  initial: FactsCurrent;
  locale: string;
  enabled: boolean;
  search: EntityPickerSearch;
  editors: AlbumEditors;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [read, setRead] = useState<FactsCurrent>(initial);
  const [loadFailure, setLoadFailure] =
    useState<Extract<Awaited<ReturnType<FactsTransport['read']>>, { ok: false }>['reason']>();
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [reviewing, setReviewing] = useState<{ property: string; candidate: string; session?: string | undefined }>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const current = read;
  const subject = current?.public.subject;
  const fields = current ? albumFields(current.release) : undefined;
  const title = pickText(subject?.labels ?? {}, locale).text;
  const href = subject ? subjectHref({ id: subject.id, label: title }, locale).href : '';
  const label = subject?.labels;
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  const reload = async () => {
    if (!lifetime.active()) return;
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await editors.facts.read();
      if (!lifetime.active()) return;
      if (next.ok && next.public.subject.type === albumType && next.release.types[albumType]) {
        setRead(next);
        setLoadFailure(undefined);
      } else setLoadFailure(next.ok ? 'invalid' : next.reason);
    } catch {
      if (!lifetime.active()) return;
      setLoadFailure('unavailable');
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!lifetime.active()) return;
    if (running.current || !current || !enabled || loadFailure || !changed.length) return;
    running.current = true;
    setBusy(true);
    try {
      const sealed = sealFacts(current.public.subject.id, current.release, drafts);
      setDrafts(sealed);
      await sendFacts(sealed, editors.facts.propose, (property, result) => {
        if (!lifetime.active()) return;
        setDrafts((previous) => previous.map((draft) => (draft.property === property ? { ...draft, result } : draft)));
      });
      if (!lifetime.active()) return;
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-8" aria-busy={busy}>
      {loadFailure && <EditorFailure reason={loadFailure} locale={locale} />}
      <section
        aria-label={m.album_identity({}, o)}
        className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      >
        <h2
          className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans text-2xl font-semibold"
          lang={pickText(label ?? {}, locale).lang ?? undefined}
        >
          {title || m.subject_value_unlabelled({}, o)}
        </h2>
        <p className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]">
          <DefinitionMeaning values={current.release.types[subject!.type]?.labels} locale={locale} />
        </p>
        <p className="text-sm font-medium">{m.specialist_identity_scope({}, o)}</p>
        <p className="text-muted-foreground">{m.album_grain({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.album_scope({}, o)}</p>
        <div className="flex min-w-0 flex-wrap gap-3 [&>a]:h-auto [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:break-words [&>a]:[overflow-wrap:anywhere]">
          <a className={buttonVariants({ variant: 'outline' })} href={href}>
            {m.candidate_view_public({}, o)}
          </a>
          <SubjectTermsEntry id={subject!.id} label={title} locale={locale} />
          <DefinitionGuideLink locale={locale} address={{ type: subject!.type, returnTo: `${href}/album` }} />
        </div>
        <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3">
          <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
            {m.specialist_identity_names({}, o)}
          </summary>
          <dl className="mt-3 min-w-0 space-y-3">
            {Array.from(
              new Set([
                ...Object.keys(subject!.labels),
                ...Object.keys(subject!.descriptions),
                ...Object.keys(subject!.aliases),
              ]),
            ).map((language) => (
              <div key={language} className="min-w-0">
                <dt className="text-sm text-muted-foreground">{language}</dt>
                <dd
                  lang={language}
                  className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                >
                  {subject!.labels[language]}
                </dd>
                {subject!.descriptions[language] && (
                  <dd
                    lang={language}
                    className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm"
                  >
                    {subject!.descriptions[language]}
                  </dd>
                )}
                {!!subject!.aliases[language]?.length && (
                  <dd
                    lang={language}
                    className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm text-muted-foreground"
                  >
                    {subject!.aliases[language]!.join(' · ')}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </details>
        <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border border-border p-4">
          <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
            {m.specialist_identity_reference({}, o)}
          </summary>
          <dl className="mt-3 min-w-0 space-y-3">
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.specialist_identity_subject_id({}, o)}</dt>
              <dd className="min-w-0">
                <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                  {subject!.id}
                </code>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.specialist_identity_type({}, o)}</dt>
              <dd className="min-w-0">
                <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                  {subject!.type}
                </code>
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{m.album_terms_help({}, o)}</p>
        </details>
      </section>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-xl font-semibold">{m.album_facts({}, o)}</h2>
        <p className="text-sm text-muted-foreground">
          {m.facts_intro({}, o)} {m.facts_separate_results({}, o)}
        </p>
        <fieldset disabled={!enabled || !!loadFailure} className="space-y-4">
          {fields!.scalar.map((property) => (
            <FactField
              key={property}
              property={property}
              read={current}
              locale={locale}
              href={href}
              busy={busy}
              canStage={drafts.length < factLimit}
              draft={drafts.find((draft) => draft.property === property)}
              onReview={setReviewing}
              onChange={(draft) =>
                setDrafts((previous) => previous.map((item) => (item.property === draft.property ? draft : item)))
              }
              onStage={(source) => {
                const draft = stageFact(current, property, source);
                if (draft) setDrafts((previous) => (previous.length < factLimit ? [...previous, draft] : previous));
              }}
            />
          ))}
          <div className="space-y-3 rounded-xl border border-border p-4">
            <p>{m.facts_selection({ count: changed.length, limit: factLimit }, o)}</p>
            <Button type="submit" disabled={busy || !changed.length}>
              {m.facts_submit({}, o)}
            </Button>
          </div>
        </fieldset>
      </form>
      {reviewing && (
        <ExactReview
          key={`${reviewing.property}:${reviewing.candidate}`}
          id={subject!.id}
          locale={locale}
          address={reviewing}
          review={editors.review}
        />
      )}
      <section className="space-y-4" aria-label={m.album_credits_parts({}, o)}>
        <h2 className="text-xl font-semibold">{m.album_credits_parts({}, o)}</h2>
        <p className="text-sm text-muted-foreground">{m.album_credits_help({}, o)}</p>
        {fields!.relations
          .filter((id) => ['credit', 'membership'].includes(current.release.properties[id]!.relation!.group))
          .map((property) => (
            <section key={property} className="space-y-2">
              <h3 className="font-semibold">
                <DefinitionMeaning values={current.release.properties[property]!.labels} locale={locale} />
              </h3>
              <SelectedFacts property={property} read={current} locale={locale} />
            </section>
          ))}
        <fieldset disabled={!enabled || !!loadFailure}>
          <RelationEditor
            id={subject!.id}
            locale={locale}
            search={search}
            transport={editors.relations}
            initial={{
              ok: true,
              public: current.public,
              fields: relationFields(current.release, albumType, locale),
              names: Object.fromEntries(
                Object.entries(current.release.properties).map(([id, property]) => [id, property.labels]),
              ),
              page: null,
            }}
            onSelected={async () => {
              if (!lifetime.active()) return;
              await Promise.all([reload(), editors.onSelected?.()]);
              if (!lifetime.active()) return;
            }}
          />
        </fieldset>
      </section>
      {!!fields!.classifications.length && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">{m.album_classification({}, o)}</h2>
          {fields!.classifications.map((property) => (
            <div key={property} className="space-y-2">
              <h3 className="font-medium">
                <DefinitionMeaning values={current.release.properties[property]!.labels} locale={locale} />
              </h3>
              {(subject!.statements[property] ?? []).map((statement) => (
                <div key={statement.id}>
                  <PartValue part={statement} read={current} locale={locale} />
                </div>
              ))}
              {!subject!.statements[property]?.length && (
                <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
              )}
            </div>
          ))}
        </section>
      )}
      {!!fields!.authored.length && (
        <section className="space-y-3 rounded-xl border border-border p-4 sm:p-5">
          <h2 className="text-xl font-semibold">{m.album_summary({}, o)}</h2>
          <p className="text-sm text-muted-foreground">{m.album_summary_help({}, o)}</p>
          <AuthoredFieldEntry id={subject!.id} title={title} locale={locale} />
        </section>
      )}
      <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
        {m.correction_reload({}, o)}
      </Button>
    </div>
  );
}
