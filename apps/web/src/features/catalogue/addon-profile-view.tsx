import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { pageText } from '../pages/data';
import { ViewHeadingActions } from '../pages/view-heading';
import type { CreateResult } from './create-subject';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { EditorFailure } from './statement-editor-view';
import { AddonProfileCreate } from './addon-profile-create';
import { CharacterClassification } from './character-profile-classification';
import { addonFacts, addonType, type AddonAddress, type AddonRead, type AddonTransport } from './addon-profile';

export type AddonProfileProps = AddonAddress & {
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: AddonTransport;
  search: EntityPickerSearch;
  facts: (id: string) => FactsTransport;
  review: (id: string, property: string, session?: string) => CandidateTransport;
  relations: (id: string) => RelationTransport;
};

export function AddonProfile({
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
  const o = { locale: locale as never };
  const [id, setId] = useState(initialId);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const query = useQuery({
    queryKey: ['addon-profile', id, work, locale, session],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
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
  const profileDescription = pageText(read?.release.types[addonType]?.descriptions, locale);
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <ViewHeadingActions
        label={m.addon_title({}, o)}
        headingClassName="font-sans"
        actions={
          href && (
            <a href={href} className={buttonVariants({ variant: 'outline' })}>
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
        <div hidden={!query.data?.ok} className="space-y-8">
          <section className="space-y-2 rounded-xl border border-border p-4">
            <p>
              <span lang={profileLabel.lang}>{profileLabel.text}</span> <code>{addonType}</code>
            </p>
            <p lang={profileDescription.lang}>{profileDescription.text}</p>
            {read.public && (
              <p lang={label.lang} className="font-medium">
                {label.text}
              </p>
            )}
            {read.work && (
              <p>
                {m.addon_base({}, o)}:{' '}
                <a
                  className="underline"
                  lang={pageText(read.work.subject.labels, locale).lang}
                  href={
                    subjectHref(
                      { id: read.work.subject.id, label: pageText(read.work.subject.labels, locale).text },
                      locale,
                    ).href
                  }
                >
                  {pageText(read.work.subject.labels, locale).text}
                </a>
              </p>
            )}
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
                <a className={buttonVariants()} href={`${created.reader.href}/addon`}>
                  {m.addon_correct({}, o)}
                </a>
              )}
            </>
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
                <h2 className="text-xl font-semibold">{m.addon_relations({}, o)}</h2>
                <RelationEditor
                  key={`relations:${id}`}
                  id={read.public.subject.id}
                  locale={locale}
                  search={search}
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
        onClick={() => {
          void query.refetch();
        }}
      >
        {m.correction_reload({}, o)}
      </Button>
    </article>
  );
}
