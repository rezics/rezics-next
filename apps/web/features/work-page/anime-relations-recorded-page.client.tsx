'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { materializeData } from 'native-i18n';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import type { MainClient } from '../discover/types.ts';
import { showsEditionStatus, workExperience } from '../entity-page/experience.ts';
import { mainRelationships } from '../relationships/api.ts';
import { SeriesProgressPanel } from '../tracking/series-progress-panel.tsx';
import { BFF_PREFIX } from '../api/browser.ts';
import { readOwnWorkShowcase } from '../api/showcase.ts';
import { workShowcaseHeader } from '../showcase/work-header.tsx';
import { messages as showcaseMessages } from '../showcase/messages.ts';
import { PartsPreviewView, ConnectionsPreviewView } from '../work-levels/previews.tsx';
import { readDatedAnimeHub } from './anime-hub-recorded-page.ts';
import { animeRelationsReads, readAnimeRelationsConnections, readAnimeRelationsPreview,
  readAnimeRelationsRatings, readAnimeRelationsStats } from './anime-relations-recorded-page.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';
import { readSuppliedContents, readSuppliedStart } from './games-hub-recorded-page.ts';
import { ContentsRegion } from './contents.tsx';
import { hubLabels, hubPlan } from './hub.ts';
import { coverAuthors, WorkCredits } from './credits.tsx';
import { messages } from './messages.ts';
import { IdentityStatus, nextAction, NextActionView } from './primary-action.tsx';
import { publicationSource } from './publication-source.tsx';
import { RatingLine } from './ratings.tsx';
import { EVERYONE, workHref } from './route.ts';
import { shelfWords } from './shelf-words.ts';
import { WorkKindActions } from './types/actions.tsx';
import { WorkFrame, WorkPageCover } from './work-frame.tsx';
import { WorkNotFound, WorkSkeleton, WorkUnavailable } from './work-states.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { copyOf } from '../work-levels/messages.ts';
import { AnimeRelationsSections } from './anime-relations-recorded-page.tsx';

export type AnimeRelationsView = 'connections' | 'contents' | 'overview';

/** Mount the existing production frame and regions with the supplied, persona-bound client. */
export function AnimeRelationsRecordedPage({ main, fetcher, actingSubject, id, view, locale }: {
  main: MainClient; fetcher: typeof fetch; actingSubject?: string; id: string; view: AnimeRelationsView; locale: UiLocale;
}) {
  const [content, setContent] = useState<ReactNode>(null);
  const [fault, setFault] = useState<string | null>(null);
  const t = messages[locale];
  useEffect(() => {
    let mounted = true;
    setContent(null);
    setFault(null);
    void (async () => {
      const page = await readDatedAnimeHub(main, actingSubject, id);
      if (!mounted) return;
      if (!page.header.ok) {
        setContent(page.header.failure === 'missing' ? <WorkNotFound messages={t} /> : <WorkUnavailable messages={t} />);
        return;
      }
      if (!page.projection || !page.agentCredits || !page.credits || !page.releases)
        throw new Error('Successful hub read lacks its production regions');
      const work = page.header.data;
      const host = { main, actingSubject };
      const reads = animeRelationsReads(host);
      const editionReads = booksEditionReads(host);
      const experience = workExperience(page.projection.ok ? page.projection.data : null, work.types);
      const [connections, preview, contents, identity, ratings, art, start] = await Promise.all([
        view === 'connections' || view === 'overview' ? readAnimeRelationsConnections(reads, id, { grain: 'series' }) : null,
        view === 'overview' ? readAnimeRelationsPreview(reads, id) : null,
        view === 'contents' ? readSuppliedContents(host, id, {}) : null,
        readBooksEditionStatus(editionReads, id, locale),
        readAnimeRelationsRatings(host, id, EVERYONE),
        readOwnWorkShowcase(work.id, fetcher),
        experience.kind === 'book' ? readSuppliedStart(host, id, work.id, async () => {
          if (!work.selectedLanguage) throw new Error('This visit needs the production text-version read');
          return work.selectedLanguage;
        }) : null,
      ]);
      const stats = await readAnimeRelationsStats(host, id, ratings.ok ? ratings.data.context?.context : undefined);
      if (!mounted) return;
      const words = materializeData(t, { locale });
      const authors = coverAuthors(page.agentCredits, page.credits, key => words.openLibraryAuthor({ key }));
      const action = nextAction({ start, preference: identity.preference, progress: identity.progress.ok ? identity.progress : null,
        releases: page.releases.ok ? page.releases.data.count.value : 0 });
      const actions = actingSubject ? createReaderStore({ actingSubject, seed: page.seed ?? {}, main: () => main }) : undefined;
      setContent(<WorkFrame workRef={id} work={work} experience={experience} locale={locale} messages={t}
        signedIn={Boolean(actingSubject)} actingSubject={page.seed ? actingSubject : undefined}
        readerSeed={page.seed ?? undefined} readerActions={actions}
        relationships={actingSubject ? mainRelationships(actingSubject, { origin: `http://record.invalid${BFF_PREFIX}`, fetch: fetcher }) : undefined}
        signInHref={signInPath(localizedPath(workHref(id), locale))}
        showcase={workShowcaseHeader(art.get(work.id), showcaseMessages[locale])}
        sections={hubLabels(t, hubPlan(page.projection.ok ? page.projection.data : null))}
        cover={<WorkPageCover work={work} authors={authors} />}
        credits={<WorkCredits agentCredits={page.agentCredits} credits={page.credits} source={publicationSource(work)} locale={locale} messages={t} />}
        ratingLine={<RatingLine ratings={ratings} stats={stats} experience={experience} locale={locale} messages={t} />}
        ratingTarget={ratings.ok && ratings.data.context ? { work: work.id, context: ratings.data.context.context,
          mainVersion: work.mainVersion, max: ratings.data.context.scale.max } : null}
        readAction={experience.kind === 'book'
          ? action ? <NextActionView action={action} workRef={id} locale={locale} messages={t} /> : null
          : <WorkKindActions kind={experience.kind} workId={work.id} title={work.title.value} locale={locale}
            messages={t} words={shelfWords(experience, t)} />}
        status={showsEditionStatus(experience) ? <IdentityStatus {...identity} locale={locale} messages={t} /> : undefined}>
        {view !== 'contents' && actingSubject ? <SeriesProgressPanel work={work.id} locale={locale} preferenceForm={view === 'connections'} /> : null}
        {view === 'connections' && connections ? <div className="grid gap-10">
          <AnimeRelationsSections view={connections} workRef={id} id={id} query={{ grain: 'series' }} locale={locale} pageMessages={t} />
        </div> : null}
        {view === 'overview' && preview && connections ? <div className="grid gap-10">
          <PartsPreviewView {...preview} workRef={id} pageMessages={t} t={copyOf(locale)} />
          <ConnectionsPreviewView relations={connections.relations} people={connections.people} workRef={id}
            locale={locale} pageMessages={t} t={copyOf(locale)} />
        </div> : null}
        {contents ? <ContentsRegion contents={contents} workRef={id} id={id} query={{}} locale={locale} messages={t} /> : null}
      </WorkFrame>);
    })().catch(error => { if (mounted) setFault(String(error)); });
    return () => { mounted = false; };
  }, [main, fetcher, actingSubject, id, view, locale, t]);
  return fault ? <pre role="alert" className="whitespace-pre-wrap break-words">{fault}</pre>
    : content ?? <WorkSkeleton label={t.loading} />;
}
