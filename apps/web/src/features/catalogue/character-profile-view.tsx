import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { pageText } from '../pages/data';
import { ViewHeadingActions } from '../pages/view-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { EditorFailure, PartValue } from './statement-editor-view';
import { SubjectTermsEntry } from './subject-terms-entry';
import { AuthoredFieldEntry } from './authored-field-entry';
import { RelationEditor } from './relation-editor';
import { FictionalReferenceDetails, FictionalWorkReference } from './fictional-work-reference';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { CatalogueCurrentReading } from './editor-lifetime';
import type { CreateResult } from './create-subject';
import { CharacterProfileCreate } from './character-profile-create';
import { CharacterClassification } from './character-profile-classification';
import { DefinitionMeaning } from './definition-meaning';
import {
  characterFacts,
  characterGroups,
  characterRelations,
  characterType,
  characterWork,
  characterWorkFields,
  isCurrentCharacterRead,
  type CharacterAddress,
  type CharacterRead,
  type CharacterTransport,
} from './character-profile';

export type CharacterProfileProps = CharacterAddress & {
  locale: string;
  session: string;
  transport: CharacterTransport;
  search: EntityPickerSearch;
  facts: (id: string) => FactsTransport;
  review: (id: string, property: string, session?: string) => CandidateTransport;
  relations: (id: string) => RelationTransport;
};

export const CharacterProfile = catalogueEditor(CharacterProfileLive);

function CharacterProfileLive({
  id: initialId,
  work: initialWork,
  locale,
  session,
  transport,
  search,
  facts,
  review,
  relations,
}: CharacterProfileProps) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const createActionClass =
    'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8';
  const [id, setId] = useState(initialId);
  const [work, setWork] = useState(initialWork);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [reading, setReading] = useState(false);
  const query = useQuery({
    queryKey: [...['character-profile', id, work, locale], lifetime.generation],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<Extract<CharacterRead, { ok: true }> | undefined>(undefined);
  const result = query.data;
  const currentRead = isCurrentCharacterRead(result, query, { id, work });
  if (currentRead) retained.current = result;
  const current = retained.current;
  const character = current?.character;
  const label = pageText(character?.subject.labels, locale);
  const href =
    currentRead && character ? subjectHref({ id: character.subject.id, label: label.text }, locale).href : undefined;
  const groups = current ? characterGroups(current.release) : undefined;
  const groupLabels = {
    identity: m.character_identity({}, o),
    traits: m.character_traits({}, o),
    measurements: m.character_measurements({}, o),
    identifiers: m.character_identifiers({}, o),
  };
  return (
    <article className="mx-auto w-full min-w-0 max-w-4xl space-y-8 px-4 py-8 [overflow-wrap:anywhere] sm:px-6">
      <ViewHeadingActions
        label={m.character_title({}, o)}
        headingClassName="font-sans"
        actions={
          currentRead &&
          href && (
            <a href={href} className={buttonVariants({ variant: 'outline' })}>
              {m.candidate_view_public({}, o)}
            </a>
          )
        }
      />
      <p className="text-muted-foreground">{m.character_intro({}, o)}</p>
      {query.isFetching && !currentRead && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError ||
        (query.data && !query.data.ok) ||
        (query.isSuccess && !query.isFetching && query.data?.ok && !currentRead)) && (
        <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
      )}
      <Button variant="outline" onClick={() => void query.refetch()}>
        {m.correction_reload({}, o)}
      </Button>
      {session === 'unavailable' ? (
        <EditorFailure reason="unavailable" locale={locale} />
      ) : (
        session !== 'signed-in' && (
          <p role="status">
            {session === 'signed-out' ? m.catalogue_create_signed_out({}, o) : m.candidate_loading({}, o)}
          </p>
        )
      )}
      {current && (
        <div hidden={!currentRead} className="space-y-8">
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
            <h2 className="text-xl font-semibold">{m.character_identity({}, o)}</h2>
            <p lang={pageText(current.release.types[characterType]!.labels, locale).lang}>
              {pageText(current.release.types[characterType]!.labels, locale).text}
            </p>
            <p className="text-sm text-muted-foreground">
              <DefinitionMeaning values={current.release.types[characterType]!.descriptions} locale={locale} />
            </p>
            {character ? (
              <>
                <p className="text-lg font-medium" lang={label.lang}>
                  {label.text || m.subject_value_unlabelled({}, o)}
                </p>
                {Object.entries(character.subject.descriptions).map(([language, text]) => (
                  <p key={language} lang={language}>
                    {text}
                  </p>
                ))}
                <div className="flex flex-wrap gap-2">
                  <SubjectTermsEntry id={character.subject.id} label={label.text} locale={locale} />
                  {current.release.types[characterType]!.properties.includes('schema:abstract') &&
                    current.release.properties['schema:abstract']?.datatype === 'document' && (
                      <AuthoredFieldEntry id={character.subject.id} title={label.text} locale={locale} />
                    )}
                </div>
                <p className="text-sm text-muted-foreground">{m.character_terms_help({}, o)}</p>
              </>
            ) : created ? (
              <ContentItemFrame
                as="div"
                data-slot="character-created"
                className="min-w-0 space-y-3 py-3 [overflow-wrap:anywhere]"
              >
                <p role="status">{m.character_created({}, o)}</p>
                <details className="min-w-0 text-sm">
                  <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                    {m.catalogue_creation_technical_details({}, o)}
                  </summary>
                  <dl className="min-w-0">
                    <dt>{m.specialist_identity_subject_id({}, o)}</dt>
                    <dd>
                      <code className="select-all [overflow-wrap:anywhere]">{created.id}</code>
                    </dd>
                  </dl>
                </details>
                {created.reader.state === 'ready' ? (
                  <div className="flex flex-wrap gap-2">
                    <a className={buttonVariants({ className: createActionClass })} href={created.reader.href}>
                      {m.candidate_view_public({}, o)}
                    </a>
                    <a
                      className={buttonVariants({ variant: 'outline', className: createActionClass })}
                      href={`${created.reader.href}/character${work ? `?work=${encodeURIComponent(work)}` : ''}`}
                    >
                      {m.character_correct({}, o)}
                    </a>
                  </div>
                ) : (
                  <>
                    <p>
                      {created.reader.state === 'concealed'
                        ? m.catalogue_create_concealed({}, o)
                        : m.catalogue_create_reader_unavailable({}, o)}
                    </p>
                    <Button
                      className={createActionClass}
                      disabled={reading}
                      onClick={async () => {
                        if (!lifetime.active()) return;
                        if (reading) return;
                        setReading(true);
                        try {
                          const reader = await transport.read(created.id);
                          if (!lifetime.active()) return;
                          setCreated({ ...created, reader });
                        } catch {
                          if (!lifetime.active()) return;
                          setCreated({ ...created, reader: { state: 'unavailable' } });
                        } finally {
                          if (!lifetime.active()) return;
                          setReading(false);
                        }
                      }}
                    >
                      {m.correction_retry({}, o)}
                    </Button>
                  </>
                )}
              </ContentItemFrame>
            ) : (
              <AuthoringDepartureBoundary>
                <CharacterSelection key={id ?? 'creation'} onSelect={setId}>
                  {(select) => (
                    <div hidden={session !== 'signed-in'}>
                      <EntityPicker
                        label={m.character_choose_existing({}, o)}
                        value={[]}
                        src={coverSrc}
                        search={async (text, signal) =>
                          (await search(text, signal)).filter((entry) => entry.types.includes(characterType))
                        }
                        onValueChange={(items) => {
                          const destination = items[0]?.id;
                          if (destination) select(destination);
                        }}
                      />
                      <CharacterProfileCreate
                        release={current.release}
                        locale={locale}
                        transport={transport}
                        onCreated={setCreated}
                        onRefreshDefinitions={async () => {
                          // Refresh creation metadata independently of the public current-reading query.
                          // Its failure must leave the entered private draft available for correction.
                          const next = await transport.load({});
                          if (!isCurrentCharacterRead(next, { isSuccess: true, isFetching: false }, {}))
                            throw new Error('Character creation definitions unavailable');
                          return next.release;
                        }}
                      />
                    </div>
                  )}
                </CharacterSelection>
              </AuthoringDepartureBoundary>
            )}
            <FictionalReferenceDetails type={characterType} locale={locale} />
          </section>
          {character && groups && (
            <>
              {Object.entries(groups).map(([group, properties]) => (
                <section key={group} className="space-y-4">
                  <h2 className="text-xl font-semibold">{groupLabels[group as keyof typeof groupLabels]}</h2>
                  <dl className="space-y-4">
                    {properties.map((property) => (
                      <div key={property} className="space-y-2 rounded-xl border border-border p-4">
                        <dt
                          className="font-medium"
                          lang={pageText(current.release.properties[property]!.labels, locale).lang}
                        >
                          {pageText(current.release.properties[property]!.labels, locale).text}
                        </dt>
                        <dd className="space-y-3">
                          {!character.subject.statements[property]?.length && (
                            <p className="text-muted-foreground">{m.facts_no_value({}, o)}</p>
                          )}
                          {character.subject.statements[property]?.map((statement) => (
                            <div key={statement.id} className="space-y-2">
                              <PartValue
                                part={statement}
                                read={{ release: current.release, public: character }}
                                locale={locale}
                              />
                              {statement.qualifiers.map((part, index) => (
                                <p key={index} className="text-sm">
                                  <span
                                    lang={pageText(current.release.properties[part.property.id]?.labels, locale).lang}
                                  >
                                    {pageText(current.release.properties[part.property.id]?.labels, locale).text}
                                  </span>
                                  :{' '}
                                  <PartValue
                                    part={part}
                                    read={{ release: current.release, public: character }}
                                    locale={locale}
                                  />
                                </p>
                              ))}
                              {statement.references.map((reference, index) => (
                                <div key={index} className="border-s-2 border-border ps-3 text-sm">
                                  {reference.parts.map((part, at) => (
                                    <PartValue
                                      key={at}
                                      part={part}
                                      read={{ release: current.release, public: character }}
                                      locale={locale}
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              <div hidden={session !== 'signed-in'}>
                <SubjectFacts
                  key={character.subject.id}
                  initial={characterFacts(current)}
                  locale={locale}
                  transport={facts(character.subject.id)}
                  review={(property, token) => review(character.subject.id, property, token)}
                />
              </div>
              <div hidden={session !== 'signed-in'} className="space-y-4">
                <CatalogueCurrentReading
                  visible={currentRead}
                  ready={currentRead}
                  revision={`${id}:${work ?? ''}:${query.dataUpdatedAt}:${query.fetchStatus}`}
                >
                  <AuthoringDepartureBoundary>
                    {groups.traits
                      .filter(
                        (property) =>
                          current.release.properties[property]?.datatype === 'wikibase-item' &&
                          current.release.properties[property]?.relation?.group === 'classification',
                      )
                      .map((property) => (
                        <CharacterClassification
                          key={`${character.subject.id}:${property}`}
                          property={property}
                          read={{ ok: true, release: current.release, public: character, source: null }}
                          locale={locale}
                          search={search}
                          transport={facts(character.subject.id)}
                          review={(field, token) => review(character.subject.id, field, token)}
                        />
                      ))}
                  </AuthoringDepartureBoundary>
                </CatalogueCurrentReading>
              </div>
            </>
          )}
          <AuthoringDepartureBoundary>
            <CharacterSelection key={work ?? 'work-picker'} onSelect={setWork}>
              {(select) => (
                <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
                  <h2 className="text-xl font-semibold">{m.character_credits({}, o)}</h2>
                  <p>{m.character_work_help({}, o)}</p>
                  {!(
                    current.work
                      ? characterWorkFields(current.release, current.work.subject.type)
                      : Object.keys(current.release.types).flatMap((type) => characterWorkFields(current.release, type))
                  ).some((id) => id !== 'schema:character' && id !== 'wdt:P725') && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {m.character_actor_gap({}, o)}
                    </p>
                  )}
                  {current.work ? (
                    <>
                      {currentRead && (
                        <FictionalWorkReference
                          subject={current.work.subject}
                          locale={locale}
                          onChooseAnother={session === 'signed-in' ? () => select(undefined) : undefined}
                        />
                      )}
                      <div hidden={session !== 'signed-in'}>
                        <RelationEditor
                          key={current.work.subject.id}
                          id={current.work.subject.id}
                          locale={locale}
                          search={search}
                          transport={{
                            ...relations(current.work.subject.id),
                            read: async (...args) =>
                              characterRelations(
                                await relations(current.work!.subject.id).read(...args),
                                current.release,
                              ),
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <EntityPicker
                      label={m.character_choose_work({}, o)}
                      value={[]}
                      src={coverSrc}
                      search={async (text, signal) =>
                        (await search(text, signal)).filter((entry) =>
                          entry.types.some((type) => characterWork(current.release, type)),
                        )
                      }
                      onValueChange={(items) => {
                        const destination = items[0]?.id;
                        if (destination) select(destination);
                      }}
                    />
                  )}
                </section>
              )}
            </CharacterSelection>
          </AuthoringDepartureBoundary>
        </div>
      )}
    </article>
  );
}

/** Each local selector includes only the holder it replaces in the existing departure decision. */
const CharacterSelection = catalogueEditor(function CharacterSelection({
  onSelect,
  children,
}: {
  onSelect: (destination: string | undefined) => void;
  children: (select: (destination: string | undefined) => void) => ReactNode;
}) {
  const lifetime = useEditorLifetime();
  const { requestNavigation } = useAuthoringDeparture(false, false, 'character-selection');
  return children((destination) => {
    if (!lifetime.active()) return;
    requestNavigation(() => {
      if (!lifetime.active()) return;
      onSelect(destination);
      // Retire descendants immediately, before the selected reading replaces their mounted workspace.
      lifetime.retire();
    });
  });
});
