import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { CandidateValue, pageText } from '../pages/data';
import { ViewHeadingActions } from '../pages/view-heading';
import type { CreateResult } from './create-subject';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { RelationEditorNavigation } from './relation-editor-navigation';
import { EditorFailure } from './statement-editor-view';
import { AddonProfileCreate } from './addon-profile-create';
import { DefinitionMeaning } from './definition-meaning';
import { CharacterClassification } from './character-profile-classification';
import {
  addonBase,
  addonFacts,
  addonFields,
  addonTarget,
  addonType,
  type AddonAddress,
  type AddonRead,
  type AddonTransport,
} from './addon-profile';

export type AddonProfileProps = AddonAddress & {
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: AddonTransport;
  search: EntityPickerSearch;
  facts: (id: string) => FactsTransport;
  review: (id: string, property: string, session?: string) => CandidateTransport;
  relations: (id: string) => RelationTransport;
};
type AddonReadyRead = Extract<AddonRead, { ok: true }>;

const addonActionTarget =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';
const addonLinkTarget =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

export const AddonProfile = catalogueEditor(AddonProfileLive);

function AddonProfileLive({
  id: initialId,
  work,
  locale,
  session,
  transport,
  search,
  facts,
  review,
  relations,
}: AddonProfileProps) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [id, setId] = useState(initialId);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [baseEditorRevision, setBaseEditorRevision] = useState(0);
  const query = useQuery({
    queryKey: [...['addon-profile', id, work, locale, session], lifetime.generation],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<{ address: string; read: Extract<AddonRead, { ok: true }> } | undefined>(undefined);
  const address = JSON.stringify([id, work, locale]);
  if (query.data?.ok) retained.current = { address, read: query.data };
  const read = retained.current?.address === address ? retained.current.read : undefined;
  const label = pageText(read?.public?.subject.labels, locale);
  const href = read?.public ? subjectHref({ id: read.public.subject.id, label: label.text }, locale).href : undefined;
  const profileLabel = pageText(read?.release.types[addonType]?.labels, locale);
  const resolveBaseTarget = async (targetId: string) => {
    const current = await transport.load({ work: targetId });
    if (!current.ok) return current;
    if (current.workIssue) return { ok: false as const, reason: current.workIssue };
    if (!current.work || current.work.subject.id !== targetId) return { ok: false as const, reason: 'stale' as const };
    if (!addonFields(current.release).includes(addonBase) || !addonTarget(current.release, addonBase, current.work.subject.type))
      return { ok: false as const, reason: 'invalid' as const };
    return { ok: true as const, type: current.work.subject.type };
  };
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 py-8 sm:px-6 [overflow-wrap:anywhere]">
      <ViewHeadingActions
        label={m.addon_title({}, o)}
        headingClassName="font-sans"
        actions={
          href && (
            <a href={href} className={buttonVariants({ variant: 'outline', className: addonActionTarget })}>
              {m.candidate_view_public({}, o)}
            </a>
          )
        }
      />
      <p className="text-muted-foreground">{m.addon_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || query.data?.ok === false) && (
        <EditorFailure locale={locale} reason={query.data?.ok === false ? query.data.reason : 'unavailable'} />
      )}
      {read && (
        <div hidden={!query.data?.ok} className="min-w-0 space-y-8">
          <section className="min-w-0 space-y-3">
            <p lang={profileLabel.lang} className="text-sm text-muted-foreground">
              {profileLabel.text}
            </p>
            <p>
              <DefinitionMeaning values={read.release.types[addonType]?.descriptions} locale={locale} />
            </p>
            {read.public && (
              <ContentItemFrame as="div" data-slot="profile-addon-reference" className="min-w-0 py-3 sm:py-4">
                <ContentItemHeading
                  level={2}
                  lang={label.lang}
                  className="min-w-0 text-lg leading-snug font-semibold md:text-xl"
                >
                  {label.text || m.subject_value_unlabelled({}, o)}
                </ContentItemHeading>
              </ContentItemFrame>
            )}
            {id && read.workId && (
              <section className="min-w-0 space-y-2">
                <h2 className="font-semibold">{m.addon_base_context_title({}, o)}</h2>
                <ContentItemFrame as="div" data-slot="profile-work-reference" className="min-w-0 py-3 sm:py-4">
                  {read.work ? (
                    <>
                      <ContentItemHeading level={3} className="min-w-0 text-lg leading-snug font-semibold md:text-xl">
                        <ContentItemTitleLink
                          stretch={false}
                          className={addonLinkTarget + ' underline underline-offset-4'}
                          lang={pageText(read.work.subject.labels, locale).lang}
                          href={
                            subjectHref(
                              { id: read.work.subject.id, label: pageText(read.work.subject.labels, locale).text },
                              locale,
                            ).href
                          }
                        >
                          {pageText(read.work.subject.labels, locale).text || m.subject_value_unlabelled({}, o)}
                        </ContentItemTitleLink>
                      </ContentItemHeading>
                      <p className="text-sm text-muted-foreground">
                        <code>{read.work.subject.id}</code> · {read.work.subject.type}
                      </p>
                      {read.workIssue && <EditorFailure locale={locale} reason={read.workIssue} />}
                    </>
                  ) : (
                    <>
                      <p><code>{read.workId}</code></p>
                      <EditorFailure locale={locale} reason={read.workIssue ?? 'unavailable'} />
                    </>
                  )}
                  <p className="text-sm">{m.addon_base_context_note({}, o)}</p>
                </ContentItemFrame>
              </section>
            )}
            <details
              className="min-w-0 max-w-full text-sm"
              aria-label={`${m.addon_title({}, o)} · ${m.profile_work_reference_details({}, o)}`}
            >
              <summary
                className={
                  addonActionTarget +
                  ' cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                }
              >
                {m.profile_work_reference_details({}, o)}
              </summary>
              <dl className="grid min-w-0 gap-3 py-2">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{m.profile_work_reference_type({}, o)}</dt>
                  <dd>
                    <code
                      tabIndex={0}
                      className="block max-w-full select-text whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {addonType}
                    </code>
                  </dd>
                </div>
                {read.public && (
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.profile_work_reference_subject({}, o)}</dt>
                    <dd>
                      <code
                        tabIndex={0}
                        className="block max-w-full select-text whitespace-normal [overflow-wrap:anywhere]"
                      >
                        {read.public.subject.id}
                      </code>
                    </dd>
                  </div>
                )}
                {read.work && (
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{m.addon_base_context_title({}, o)}</dt>
                    <dd>
                      <code
                        tabIndex={0}
                        className="block max-w-full select-text whitespace-normal [overflow-wrap:anywhere]"
                      >
                        {read.work.subject.id}
                      </code>
                    </dd>
                  </div>
                )}
              </dl>
            </details>
          </section>
          {!id && (
            <>
              <EntityPicker
                label={m.addon_choose_existing({}, o)}
                value={[]}
                src={coverSrc}
                disabled={session !== 'signed-in'}
                search={async (text, signal) =>
                  (await search(text, signal)).filter((entry) => entry.types.includes(addonType))
                }
                onValueChange={(items) => {
                  if (items[0]) setId(items[0].id);
                  if (!lifetime.active()) return;
                }}
              />
              <AddonProfileCreate
                read={read}
                locale={locale}
                session={session}
                transport={transport}
                search={search}
                onCreated={setCreated}
              />
              {created?.reader.state === 'ready' && (
                <a className={buttonVariants({ className: addonActionTarget })} href={`${created.reader.href}/addon`}>
                  {m.addon_correct({}, o)}
                </a>
              )}
            </>
          )}
          {read.public && (
            <section className="min-w-0 space-y-3">
              <h2 className="text-xl font-semibold">{m.addon_base_current_title({}, o)}</h2>
              {!addonFields(read.release).includes(addonBase) && (
                <p role="status">{m.addon_base_withdrawn({}, o)}</p>
              )}
              <AddonBaseCurrent read={read as AddonReadyRead & { public: NonNullable<AddonReadyRead['public']> }} locale={locale} />
            </section>
          )}
          {read.public && (
            <div hidden={session !== 'signed-in'} className="space-y-6">
              <p className="text-sm text-muted-foreground">{m.addon_corrections({}, o)}</p>
              <SubjectFacts
                key={`facts:${id}`}
                initial={addonFacts(read)}
                locale={locale}
                transport={facts(read.public.subject.id)}
                review={(property, token) => review(read.public!.subject.id, property, token)}
              />
              {read.release.types[addonType]!.properties.filter(
                (property) =>
                  read.release.properties[property]?.relation?.group === 'classification' &&
                  read.release.properties[property]?.datatype === 'wikibase-item',
              ).map((property) => (
                <CharacterClassification
                  key={property}
                  property={property}
                  read={{ ok: true, release: read.release, public: read.public!, source: null }}
                  locale={locale}
                  search={search}
                  transport={facts(read.public!.subject.id)}
                  review={(field, token) => review(read.public!.subject.id, field, token)}
                />
              ))}
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">{m.addon_base_workspace_title({}, o)}</h2>
                <p className="text-sm text-muted-foreground">{m.addon_base_workspace_intro({}, o)}</p>
                <RelationEditor
                  key={`base-relations:${id}:${baseEditorRevision}`}
                  id={read.public.subject.id}
                  locale={locale}
                  search={search}
                  propertyIds={[addonBase]}
                  initialProperty={addonBase}
                  resolveTarget={resolveBaseTarget}
                  navigation={(state) => (
                    <>
                      <RelationEditorNavigation {...state} />
                      {state.dirty && (
                        <Button
                          variant="outline"
                          disabled={state.pending}
                          onClick={() => setBaseEditorRevision((revision) => revision + 1)}
                        >
                          {m.addon_base_discard_draft({}, o)}
                        </Button>
                      )}
                    </>
                  )}
                  onSelected={() => {
                    void query.refetch();
                  }}
                  transport={relations(read.public.subject.id)}
                />
              </section>
              <section className="space-y-3">
                <h2 className="text-xl font-semibold">{m.addon_relations({}, o)}</h2>
                <RelationEditor
                  key={`relations:${id}`}
                  id={read.public.subject.id}
                  locale={locale}
                  search={search}
                  excludedProperties={[addonBase]}
                  onSelected={() => {
                    void query.refetch();
                  }}
                  transport={relations(read.public.subject.id)}
                />
              </section>
            </div>
          )}
        </div>
      )}
      {id && session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.correction_unavailable({}, o)
              : m.candidate_loading({}, o)}
        </p>
      )}
      <Button
        variant="outline"
        className={addonActionTarget}
        onClick={() => {
          void query.refetch();
        }}
      >
        {m.correction_reload({}, o)}
      </Button>
    </article>
  );
}

function AddonBaseCurrent({ read, locale }: { read: AddonReadyRead & { public: NonNullable<AddonReadyRead['public']> }; locale: string }) {
  const options = { locale: locale as never };
  const statements = read.public.subject.statements[addonBase] ?? [];
  const unresolved = read.public.subject.resolution?.[addonBase] === 'unresolved';
  if (unresolved && !statements.length) return <p role="status">{m.addon_base_current_unresolved({}, options)}</p>;
  if (!unresolved && !statements.length) return <p>{m.addon_base_current_empty({}, options)}</p>;
  return (
    <div className="space-y-3">
      {unresolved && <p role="status">{m.addon_base_current_unresolved({}, options)}</p>}
      {statements.map((statement) => (
        <ContentItemFrame key={statement.id} as="div" className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4">
          <ContentItemHeading level={3} className="font-semibold">
            {unresolved ? m.addon_base_current_unconfirmed({}, options) : m.addon_base_current_membership({}, options)}
          </ContentItemHeading>
          <div className="space-y-1">
            <CandidateValue snak={statement} related={read.public.related} locale={locale} />
            {statement.value.type === 'value' && typeof statement.value.content === 'string' && (
              <code className="block break-all text-sm">{statement.value.content}</code>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {statement.rank === 'preferred'
              ? m.relation_preferred({}, options)
              : statement.rank === 'deprecated'
                ? m.relation_deprecated({}, options)
                : m.relation_normal({}, options)}
          </p>
          {!!statement.qualifiers.length && (
            <dl className="space-y-2 text-sm">
              {statement.qualifiers.map((part, index) => (
                <div key={index}>
                  <dt className="text-muted-foreground">
                    {pageText(read.release.properties[part.property.id]?.labels ?? {}, locale).text || part.property.id}
                  </dt>
                  <dd><CandidateValue snak={part} related={read.public.related} locale={locale} /></dd>
                </div>
              ))}
            </dl>
          )}
          {!!statement.references.length && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">{m.relation_citation({}, options)}</p>
              {statement.references.map((reference, index) => (
                <div key={index} className="space-y-1 border-s-2 ps-3">
                  {reference.parts.map((part, at) => (
                    <p key={at}>
                      <span className="text-muted-foreground">
                        {pageText(read.release.properties[part.property.id]?.labels ?? {}, locale).text || part.property.id}:{' '}
                      </span>
                      <CandidateValue snak={part} related={read.public.related} locale={locale} />
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </ContentItemFrame>
      ))}
    </div>
  );
}
