import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
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

export function CharacterProfile({
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
  const o = { locale: locale as never };
  const [id, setId] = useState(initialId);
  const [work, setWork] = useState(initialWork);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [reading, setReading] = useState(false);
  const query = useQuery({
    queryKey: ['character-profile', id, work, locale],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<Extract<CharacterRead, { ok: true }> | undefined>(undefined);
  if (query.data?.ok) retained.current = query.data;
  const current = retained.current;
  const character = current?.character;
  const label = pageText(character?.subject.labels, locale);
  const href = character ? subjectHref({ id: character.subject.id, label: label.text }, locale).href : undefined;
  const groups = current ? characterGroups(current.release) : undefined;
  const groupLabels = {
    identity: m.character_identity({}, o),
    traits: m.character_traits({}, o),
    measurements: m.character_measurements({}, o),
    identifiers: m.character_identifiers({}, o),
  };
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6">
      <ViewHeadingActions
        label={m.character_title({}, o)}
        headingClassName="font-sans"
        actions={
          href && (
            <a href={href} className={buttonVariants({ variant: 'outline' })}>
              {m.candidate_view_public({}, o)}
            </a>
          )
        }
      />
      <p className="text-muted-foreground">{m.character_intro({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || (query.data && !query.data.ok)) && (
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
        <div hidden={!query.data?.ok} className="space-y-8">
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
            <h2 className="text-xl font-semibold">{m.character_identity({}, o)}</h2>
            <p lang={pageText(current.release.types[characterType]!.labels, locale).lang}>
              {pageText(current.release.types[characterType]!.labels, locale).text}{' '}
              <code className="text-sm">{characterType}</code>
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
              <div className="space-y-3">
                <p role="status">{m.character_created({}, o)}</p>
                <code className="break-all">{created.id}</code>
                {created.reader.state === 'ready' ? (
                  <div className="flex flex-wrap gap-2">
                    <a className={buttonVariants()} href={created.reader.href}>
                      {m.candidate_view_public({}, o)}
                    </a>
                    <a
                      className={buttonVariants({ variant: 'outline' })}
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
                      disabled={reading}
                      onClick={async () => {
                        if (reading) return;
                        setReading(true);
                        try {
                          setCreated({ ...created, reader: await transport.read(created.id) });
                        } catch {
                          setCreated({ ...created, reader: { state: 'unavailable' } });
                        } finally {
                          setReading(false);
                        }
                      }}
                    >
                      {m.correction_retry({}, o)}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div hidden={session !== 'signed-in'}>
                <EntityPicker
                  label={m.character_choose_existing({}, o)}
                  value={[]}
                  src={coverSrc}
                  search={async (text, signal) =>
                    (await search(text, signal)).filter((entry) => entry.types.includes(characterType))
                  }
                  onValueChange={(items) => {
                    if (items[0]) setId(items[0].id);
                  }}
                />
                <CharacterProfileCreate
                  release={current.release}
                  locale={locale}
                  transport={transport}
                  onCreated={setCreated}
                />
              </div>
            )}
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
              </div>
            </>
          )}
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
                <a
                  className="underline"
                  href={
                    subjectHref(
                      { id: current.work.subject.id, label: pickText(current.work.subject.labels, locale).text },
                      locale,
                    ).href
                  }
                  lang={pageText(current.work.subject.labels, locale).lang}
                >
                  {pickText(current.work.subject.labels, locale).text}
                </a>
                <code className="block break-all text-sm">{current.work.subject.id}</code>
                <div hidden={session !== 'signed-in'}>
                  <RelationEditor
                    key={current.work.subject.id}
                    id={current.work.subject.id}
                    locale={locale}
                    search={search}
                    transport={{
                      ...relations(current.work.subject.id),
                      read: async (...args) =>
                        characterRelations(await relations(current.work!.subject.id).read(...args), current.release),
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
                  if (items[0]) setWork(items[0].id);
                }}
              />
            )}
          </section>
        </div>
      )}
    </article>
  );
}
