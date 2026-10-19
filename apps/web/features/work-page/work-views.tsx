import { headers } from 'next/headers';
import { materializeData } from 'native-i18n';
import { cache, type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { mainApiWithToken, readPlatformAccess, type AnonymousMainClient } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { signInPath } from '../auth/paths.ts';
import { browseReader } from '../discover/server.ts';
import { lifespan } from '../author/facts.ts';
import { messages as authorMessages } from '../author/messages.ts';
import authorZhHans from '../author/messages/zh-Hans.ts';
import { readOpenLibraryAuthor, readOpenLibraryAuthorWorks } from '../author/read.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import type { RelationshipsApi } from '../relationships/types.ts';
import { authorSeparator, coverKindOf } from '../catalogue/work.ts';
import { AdoptionRegion } from './adoption.tsx';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import { AuthorSection } from './author.tsx';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import { readFacets } from '../concept/read.ts';
import { ClassificationRegion, type CommunityGenres } from './classification.tsx';
import { WorkCredits, WorkCreditsSkeleton, citationAuthors, coverAuthors } from './credits.tsx';
import { HistoryRegion } from './history.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import { readContentsGroup } from './contents-actions.ts';
import { ProvisionalNotice } from '../catalogue-intake/provisional-notice.tsx';
import { ContentsRegion } from './contents.tsx';
import { DiscussionRegion } from './discussion.tsx';
import { booksEditionReads } from './books-edition-page.read.ts';
import { publicationSource } from './publication-source.tsx';
import { readAnimeAgentCredits, readAnimeReaderState, readAnimeWorkCredits, readSelectedWorkCredits } from './anime-hub-recorded-page.ts';
import { oneTextLanguage, readAdoptions, readAgentWorks, readAlsoEnjoyed, readClassifications,
  readContents, readDiscussion, readHistory, readingAgent, readRatings, readRealm,
  readReviewer, readReviews, readVersions, readWorkStats, readReleases,
  readHubWorkPage, readText, readRatingPopulations, reader, type SuppliedClient } from './read.ts';
import { Region, RegionFailure, RegionSkeleton } from './region.tsx';
import { WorkRecord } from './record.tsx';
import { type ContentsQuery, EVERYONE, mainScope, type HistoryFilter, idOf, type VersionQuery, type WorkAt, type WorkScope,
  workHref, workRefOf } from './route.ts';
import { ScopeBar, ScopeBarSkeleton, type ScopeRealm, type ScopeView } from './scope-bar.tsx';
import { ReviewsSection } from './reviews.tsx';
import { aggregateOf } from './reviews-grain-model.tsx';
import { reviewTargets } from './reviews-grain-options.tsx';
import type { WorkHeader as Header, Reviewer } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { InvalidScope, OverviewLayout, ReadButton, WorkFrame, WorkPageCover } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';
import { readOwnWorkShowcase, readShowcaseImages } from '../api/showcase.ts';
import { workShowcaseHeader } from '../showcase/work-header.tsx';
import { WorkTypeSections } from '../zones/work-sections.tsx';
import { AboutFacts, Availability, DiscussionHub, Parts, PrimaryAction, readWorkFacts, Status } from './hub-sections.tsx';
import type { DisplayObligations } from '../rights-mark/rights-mark.tsx';
import { type HubSection, hubLabels, hubPlan } from './hub.ts';
import { WikiSection, WikiShortcut } from './wiki-server.tsx';
import { readCurrentWorkProjection } from './current-projection.ts';
import { showsEditionStatus, type WorkExperience, workExperience } from '../entity-page/experience.ts';
import { shelfWords } from './shelf-words.ts';
import { WorkKindActions } from './types/actions.tsx';
import type { RecipeWorkHost } from './recipe-reading-recorded-page.ts';
import { recipeRegion, recipeWorkFrame, recipeWorkOverview } from './recipe-reading-recorded-page.tsx';
import { HubExperience } from './types/hub.tsx';
import { GuideExperience } from './types/guide.tsx';
import { NextActionView } from './primary-action.tsx';

// Server compositions for the `/w/[ref]` routes: each region reads Main on its
// own under Suspense, so the page streams as answers arrive and one failure
// stays in its region.

/** The shared showcase read is an anonymous browser client. Perform it with the anonymous server client. */
async function anonymousShowcaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const body: unknown = await request.json();
  const record = body && typeof body === 'object' ? body as { profile?: unknown; targets?: unknown; context?: unknown } : {};
  if (record.profile !== 'work-showcase-batch-v1' || !Array.isArray(record.targets)
    || record.targets.some(target => typeof target !== 'string')) {
    return Response.json({ title: 'Showcase unavailable' }, { status: 502 });
  }
  const result = await mainApiWithToken(undefined).v1.resources.showcase.post({
    profile: 'work-showcase-batch-v1',
    targets: record.targets as string[],
    ...(typeof record.context === 'string' ? { context: record.context } : {}),
  });
  if (result.error) {
    return Response.json(result.error.value ?? { title: 'Showcase unavailable' }, { status: result.error.status });
  }
  return Response.json(result.data ?? { title: 'Showcase unavailable' }, { status: result.data ? 200 : 502 });
}

/** The host the recipe frame and overview share. Showcase stays on the anonymous client. */
async function recipePageHost(): Promise<RecipeWorkHost> {
  const { main, actingSubject, signedIn } = await reader();
  return {
    main,
    anonymous: mainApiWithToken(undefined),
    publicOrigin: 'http://127.0.0.1',
    publicFetch: anonymousShowcaseFetch as typeof fetch,
    actingSubject: actingSubject ?? null,
    signedIn,
  };
}

/** The request's clients and presentation inputs, also supplied unchanged by recorded surfaces. */
export interface WorkPageClient extends SuppliedClient {
  anonymous: AnonymousMainClient;
  signedIn: boolean;
  avatarQuery?: string;
  pageUrl?: string | null;
}


interface Common { locale: UiLocale; messages: WorkPageMessages; client?: WorkPageClient }

// An explicit host resolves the same server slots into streamed promises. The
// default host leaves them as server components, with each cached reader reached
// only when React renders that slot under its existing Suspense boundary.

/** Realms the scope bar and empty states can offer: those that adopted the Work, plus the one in the URL. */
async function scopeRealms(id: string, scope: WorkScope | null, locale: UiLocale, client?: WorkPageClient): Promise<ScopeRealm[]> {
  const [adoptions, current] = await Promise.all([readAdoptions(id, locale, client),
    scope?.kind === 'realm' ? readRealm(scope.realm, locale, client) : null]);
  const realms: ScopeRealm[] = adoptions.ok ? adoptions.data.items.flatMap(item => {
    const realm = idOf(item.realm);
    return realm ? [{ id: realm, name: item.name }] : [];
  }) : [];
  if (scope?.kind === 'realm' && !realms.some(realm => realm.id === scope.realm)) {
    realms.unshift({ id: scope.realm, name: current?.ok ? current.data.name : null });
  }
  return realms;
}

async function ratingRealms(id: string, scope: WorkScope | null, locale: UiLocale, client?: WorkPageClient): Promise<ScopeRealm[]> {
  const [populations, current] = await Promise.all([readRatingPopulations(id, locale, client),
    scope?.kind === 'realm' ? readRealm(scope.realm, locale, client) : null]);
  const realms: ScopeRealm[] = populations.ok ? populations.data.items.filter(item => !item.global)
    .map(item => ({ id: item.id.slice(-36), name: item.name, ratingCount: item.ratingCount, readerCommunity: item.readerCommunity })) : [];
  if (scope?.kind === 'realm' && !realms.some(realm => realm.id === scope.realm)) {
    realms.push({ id: scope.realm, name: current?.ok ? current.data.name : null });
  }
  return realms;
}

// Author reads the first credit page. These names are that continuation record.
const readAgentCredits = cache(async (id: string, client?: WorkPageClient) => {
  const { main, actingSubject } = client ?? await reader();
  return readAnimeAgentCredits(main, actingSubject, id);
});
const readCredits = cache(async (id: string, client?: WorkPageClient) => {
  const { main, actingSubject } = client ?? await reader();
  return readAnimeWorkCredits(main, actingSubject, id);
});
const animeReaderState = cache(async (id: string, client?: WorkPageClient) => {
  const { main, actingSubject } = client ?? await reader();
  return readAnimeReaderState(main, actingSubject, id);
});

async function Credits({ id, work, locale, messages, client }: Common & { id: string; work: Header }) {
  const source = publicationSource(work);
  const host = client ?? await reader();
  const [agentCredits, credits] = await Promise.all([readAgentCredits(id, client),
    readSelectedWorkCredits(host.main, host.actingSubject, id, Boolean(source))]);
  return <WorkCredits agentCredits={agentCredits} credits={credits} source={source} locale={locale} messages={messages} />;
}

/** The cover uses the same credited names as the header, without delaying the rest of the Work page. */
async function Cover({ id, work, avatarQuery, locale, messages, client }: Common & {
  id: string; work: Header; avatarQuery?: string;
}) {
  const [agentCredits, externalCredits] = await Promise.all([readAgentCredits(id, client), readCredits(id, client)]);
  const t = materializeData(messages, { locale });
  const authors = coverAuthors(agentCredits, externalCredits, key => t.openLibraryAuthor({ key }));
  return <WorkPageCover work={work} authors={authors} avatarQuery={avatarQuery} />;
}

/**
 * Everyone's rating summary for the header, on the Work's first rating
 * question, with its reviews and the people reading the Work now.
 */
async function RatingLineSlot({ id, experience, locale, messages, client }: Common & { id: string; experience: WorkExperience }) {
  const ratings = await readRatings(id, EVERYONE, undefined, client);
  const stats = await readWorkStats(id, ratings.ok ? ratings.data.context?.context : undefined, client);
  return <RatingLine ratings={ratings} stats={stats} experience={experience} locale={locale} messages={messages} />;
}

/**
 * The page a Work gets: its registry presentation and type section, from its
 * `entity-page-v1` projection (read once per request). When Main cannot serve
 * the projection the registry's entry for the Work's types stands in and the
 * type section is left out.
 */
export const readExperience = async (id: string, types: readonly string[], client?: WorkPageClient): Promise<WorkExperience> => {
  const page = await readCurrentWorkProjection(id, client);
  return workExperience(page.ok ? page.data : null, types);
};

/** A type's own action (cook, copy, install), or for cover-led Works the one primary action the hub leads with. */
async function ReadSlot({ workRef, id, work, experience, locale, messages, client }: Common & { workRef: WorkAt; id: string;
  work: Header; experience: WorkExperience }) {
  if (experience.kind === 'book') {
    return PrimaryAction({ workRef, id, work, locale, messages, client });
  }
  if (showsEditionStatus(experience)) {
    const releases = await readReleases(id, client);
    const inventory = releases.ok ? { editions: releases.data.items, nextCursor: releases.data.nextCursor } : null;
    return inventory && (inventory.editions.length || inventory.nextCursor) ? <NextActionView
      action={{ kind: 'choose', href: '#availability', part: null }} workRef={workRef} locale={locale} messages={messages} /> : null;
  }
  if (experience.kind === 'guide') {
    const text = await readText(work.mainVersion, work.selectedLanguage ?? undefined);
    if (!text.ok || !text.data.body.trim()) return null;
  }
  const hub = experience.typeSection && experience.kind !== 'recipe' ? await readHubWorkPage(experience.typeSection.href)
    : null;
  return <WorkKindActions kind={experience.kind} workId={work.id} workRef={workRef} title={work.title.value} locale={locale}
    messages={messages} hubText={hub?.ok ? hub.data?.content ?? null : null}
    words={shelfWords(experience, messages)} />;
}

/** The hub sections the Work's projection binds, in the documented order. */
export const readHubPlan = async (id: string, client?: WorkPageClient): Promise<readonly HubSection[]> => {
  const page = await readCurrentWorkProjection(id, client);
  return hubPlan(page.ok ? page.data : null);
};

/** Header and tabs around every Work view; credits and the rating summary stream in on their own. */
export async function WorkFrameView({ workRef, id, work, locale, messages, lead, children, sources, factObligations, client, readerActions, relationships }: Common & {
  workRef: WorkAt; id: string; work: Header; children: ReactNode;
  sources?: ReactNode;
  factObligations?: readonly DisplayObligations[];
  readerActions?: ReaderActions; relationships?: RelationshipsApi;
  /** The sections a Zone's page leads with (`ZonePackage.hubOrder`). */
  lead?: readonly HubSection[];
}) {
  const experience = await readExperience(id, work.types, client);
  if (experience.kind === 'recipe') {
    return recipeWorkFrame({ host: await recipePageHost(), workRef, id, work, locale, messages, children, sources,
      factObligations, readerActions, relationships });
  }
  const agent = readingAgent(client);
  const [{ signedIn, actingSubject }, { avatarQuery }, seed, ratings, plan, art, showcaseMessages, facts] = await Promise.all([
    agent, (client ?? browseReader()), animeReaderState(id, client),
    agent.then(viewer => viewer.signedIn ? readRatings(id, EVERYONE, undefined, client) : null),
    readHubPlan(id, client),
    // One batch for the page, so the art costs one round trip however many layers it has, and one for
    // the header's images, so they are drawn (or masked) in the server's HTML.
    readOwnWorkShowcase(work.id, undefined, client?.anonymous).then(async (art) => {
      const item = art.get(work.id);
      return { item, images: item ? await readShowcaseImages(item.images.flatMap(image =>
        image.role === 'cutout' ? [] : [image.url])) : {} };
    }), getMessages('showcase', locale), readWorkFacts(id, locale, client)]);
  // The stars answer everyone's first rating question for the Main Version shown, as the summary above them does.
  const context = ratings?.ok ? ratings.data.context : null;
  const ratingTarget = context ? { work: work.id, context: context.context, mainVersion: work.mainVersion,
    max: context.scale.max } : null;
  return <WorkFrame workRef={workRef} work={work} experience={experience} locale={locale} messages={messages} signedIn={signedIn}
    statementSources={facts.page} sourceLabels={facts.labels} factObligations={factObligations}
    showcase={workShowcaseHeader(art.item, showcaseMessages, art.images)}
    actingSubject={seed ? actingSubject : null} readerSeed={seed ?? undefined} ratingTarget={ratingTarget} readerActions={readerActions} relationships={relationships}
    signInHref={signInPath(localizedPath(workHref(workRef), locale))} avatarQuery={avatarQuery}
    cover={<Suspense fallback={<WorkPageCover work={work} avatarQuery={avatarQuery} />}>
      {(client ? Cover({ id, work, avatarQuery, locale, messages, client }) : <Cover id={id} work={work} avatarQuery={avatarQuery} locale={locale} messages={messages} />)}</Suspense>}
    credits={<Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      {(client ? Credits({ id, work, locale, messages, client }) : <Credits id={id} work={work} locale={locale} messages={messages} />)}</Suspense>}
    ratingLine={<Suspense fallback={null}>{(client ? RatingLineSlot({ id, experience, locale, messages, client }) : <RatingLineSlot id={id} experience={experience} locale={locale} messages={messages} />)}</Suspense>}
    sources={<>
      {sources}
      <Suspense fallback={null}>{client ? AboutFacts({ id, locale, messages, client })
        : <AboutFacts id={id} locale={locale} messages={messages} />}</Suspense>
      <Suspense fallback={<WorkRecord work={work} locale={locale} messages={messages} />}>
        {client ? Record({ id, workRef, work, locale, messages, client })
          : <Record id={id} workRef={workRef} work={work} locale={locale} messages={messages} />}
      </Suspense>
    </>}
    sections={hubLabels(messages, plan, lead)}
    readAction={<Suspense fallback={experience.kind === 'book'
      ? <ReadButton workRef={workRef} start={{ kind: 'contents' }} messages={messages} /> : null}>
      {(client ? ReadSlot({ workRef, id, work, experience, locale, messages, client }) : <ReadSlot workRef={workRef} id={id} work={work} experience={experience} locale={locale} messages={messages} />)}
    </Suspense>}
    status={showsEditionStatus(experience) ? <Suspense fallback={null}>
      {(client ? Status({ id, work: experience.kind === 'book' ? work : undefined, locale, messages, client })
        : <Status id={id} work={experience.kind === 'book' ? work : undefined} locale={locale} messages={messages} />)}</Suspense> : undefined}
    shortcuts={<>
      <ProvisionalNotice verification={work.verification} provenance={work.fieldProvenance} locale={locale} />
      {plan.includes('wiki') ? <Suspense fallback={null}>
        {(client ? WikiShortcut({ id, locale, messages, client }) : <WikiShortcut id={id} locale={locale} messages={messages} />)}</Suspense> : null}</>}>
    {children}</WorkFrame>;
}

async function ScopeBarSlot({ workRef, id, scope, tab = 'overview', locale, messages, client }: Common & {
  workRef: WorkAt; id: string; scope: WorkScope | null; tab?: 'overview' | 'discussion';
}) {
  const [realms, agent] = await Promise.all([tab === 'overview' ? ratingRealms(id, scope, locale, client) : scopeRealms(id, scope, locale, client), readingAgent(client)]);
  return <ScopeBar workRef={workRef} scope={scope} realms={realms} tab={tab}
    target={tab === 'overview' ? `https://rezics.com/id/${id}` : undefined} actingSubject={agent.actingSubject ?? undefined}
    locale={locale} messages={messages} />;
}

type ScopedProps = Common & { workRef: WorkAt; id: string; scope: WorkScope };

async function view({ workRef, id, scope, locale, client }: ScopedProps): Promise<ScopeView> {
  return { workRef, scope, realms: await scopeRealms(id, scope, locale, client) };
}

async function Ratings(props: ScopedProps & { context: string | undefined }) {
  const [realms, ratings, agent] = await Promise.all([ratingRealms(props.id, props.scope, props.locale, props.client),
    readRatings(props.id, props.scope, props.context, props.client), readingAgent(props.client)]);
  const scopeView: ScopeView = { workRef: props.workRef, scope: props.scope, realms };
  return <RatingSummaryRegion ratings={ratings} view={scopeView} locale={props.locale} messages={props.messages}
    scopeBar={<ScopeBar workRef={props.workRef} scope={props.scope} realms={scopeView.realms} locale={props.locale}
      target={`https://rezics.com/id/${props.id}`} actingSubject={agent.actingSubject ?? undefined}
      messages={props.messages} />} />;
}

/**
 * Details with a citation: the title, native authors, REZICS and the page's
 * address in this interface language, from the proxy's record of the request.
 */
async function Record({ id, workRef, work, locale, messages, client }: Common & { id: string; workRef: WorkAt; work: Header }) {
  const [credits, page] = await Promise.all([readAgentCredits(id, client), client ? client.pageUrl : headers().then(list => list.get('x-rezics-page-url'))]);
  const authors = citationAuthors(credits);
  // A citation names the Work's own address, never a Zone's frame around it.
  const url = page ? new URL(localizedPath(workHref(workRefOf(workRef)), locale), page).toString() : null;
  const citation = url ? [work.title.value, authors.join(authorSeparator(authors)), 'REZICS', url]
    .filter(Boolean).join('. ') : undefined;
  return <WorkRecord work={work} citation={citation} locale={locale} messages={messages} />;
}

async function Author({ id, locale, messages, client }: Common & { id: string }) {
  const [agents, external] = await Promise.all([readAgentCredits(id, client), readCredits(id, client)]);
  const native = agents.ok ? agents.data.items.find(credit => credit.role === 'author') : undefined;
  if (native) {
    const [works, { avatarQuery }] = await Promise.all([readAgentWorks(native.agent, locale, client), (client ?? browseReader())]);
    return <AuthorSection author={{ kind: 'agent', name: native.displayName, handle: native.handle, agent: native.agent, works }}
      work={id} avatarQuery={avatarQuery} locale={locale} messages={messages} />;
  }
  const credit = external.ok ? external.data.items.filter(item => item.participantKind === 'external-reference')
    .filter(item => item.role === 'author')
    .sort((a, b) => a.ordinal - b.ordinal)[0] : undefined;
  if (!credit || credit.provider !== 'open-library' || !credit.key) return null;
  const [details, works, { avatarQuery }] = await Promise.all([
    readOpenLibraryAuthor(credit.key, locale, 1), readOpenLibraryAuthorWorks(credit.key, locale, 12), (client ?? browseReader()),
  ]);
  const name = details.ok ? details.data.name?.displayName ?? credit.displayName : credit.displayName;
  const t = materializeData(messages, { locale });
  return <AuthorSection author={{ kind: 'external', key: credit.key,
    name: name ?? t.openLibraryAuthor({ key: credit.key.replace(/^\/authors\//, '') }),
    years: details.ok ? lifespan(details.data.facts, locale,
      locale === 'zh-Hans' ? { ...authorMessages, ...authorZhHans } : authorMessages) : null, works }}
    work={id} avatarQuery={avatarQuery} locale={locale} messages={messages} />;
}

/**
 * Reviews answer the rating question the ratings above show (everyone's in
 * Mine), so a review's stars mean the same as the summary's. The reader can
 * write where the page's own stars rate: everyone's question.
 */
async function Reviews({ workRef, id, work, scope, context: chosen, locale, messages, client }: ScopedProps & {
  work: Header; context: string | undefined }) {
  const [ratings, everyone, { signedIn, actingSubject }] = await Promise.all([
    readRatings(id, scope.kind === 'mine' ? EVERYONE : scope, chosen, client),
    readRatings(id, EVERYONE, undefined, client), readingAgent(client)]);
  const question = ratings.ok ? ratings.data.context : null;
  if (!question) return null;
  const initial = await readReviews(id, { context: question.context, sort: 'helpful', limit: 10 }, client);
  const authors = initial.ok ? [...new Set(initial.data.items.map(review => review.author))] : [];
  const named = await Promise.all(authors.map(async author => [author, await readReviewer(author, client)] as const));
  const writable = everyone.ok && everyone.data.context?.context === question.context;
  // Editions, translations and related Works have their own rating questions, read in the scope the reviews are in.
  const targets = await reviewTargets(id, work, locale, client);
  return <ReviewsSection target={work.id} context={question.context} scale={question.scale.max} initial={initial}
    targets={targets} scopeQuery={mainScope(scope.kind === 'mine' ? EVERYONE : scope)}
    aggregate={ratings.ok ? aggregateOf(ratings.data.summary) : null}
    subject={materializeData(messages, { locale }).reviewsOf({ target: work.title.value })}
    reviewers={Object.fromEntries(named.filter((entry): entry is [string, Reviewer] => entry[1] !== null))}
    viewer={actingSubject ? { kind: 'reader', actingSubject, canWrite: writable }
      : signedIn ? { kind: 'no-identity' }
        : { kind: 'signed-out', signInHref: signInPath(localizedPath(workHref(workRef), locale)) }}
    locale={locale} messages={messages} />;
}

async function Classification(props: ScopedProps) {
  const [scopeView, classifications, facets] = await Promise.all([view(props), props.scope.kind === 'mine' ? null
    : readClassifications(props.id, props.locale, props.scope, props.client),
    props.client ? booksEditionReads({ main: props.client.anonymous }).readFacets() : readFacets()]);
  const facet = classificationFacet(facets.ok ? facets.data : null);
  // Nobody tagged it for everyone: show what the first two communities featuring it chose, named as theirs.
  const untagged = props.scope.kind === 'global' && classifications?.ok && !classifications.data.items.length;
  const communities: CommunityGenres[] = untagged ? await Promise.all(scopeView.realms.slice(0, 2).map(async realm => {
    const chosen = await readClassifications(props.id, props.locale, { kind: 'realm', realm: realm.id }, props.client);
    return { realm, items: chosen.ok ? chosen.data.items.filter(item => item.source === 'local') : [] };
  })) : [];
  return <ClassificationRegion classifications={classifications} view={scopeView} communities={communities}
    facet={facet ? { id: facet.id, label: facetLabel(facet, props.locale) } : null}
    locale={props.locale} messages={props.messages} />;
}

/** Works to read next, beside the ones this Work's readers also enjoyed. */
async function AlsoEnjoyed({ id, work, locale, messages, client }: Common & { id: string; work: Header }) {
  const [alsoEnjoyed, realms, { avatarQuery }] = await Promise.all([readAlsoEnjoyed(id, locale, client),
    scopeRealms(id, null, locale, client), (client ?? browseReader())]);
  return <AlsoEnjoyedSection alsoEnjoyed={alsoEnjoyed} book={coverKindOf(work.types) === 'book'} realms={realms}
    avatarQuery={avatarQuery} locale={locale} messages={messages} />;
}

async function Adoption(props: ScopedProps) {
  const [scopeView, adoptions] = await Promise.all([view(props), readAdoptions(props.id, props.locale, props.client)]);
  return <AdoptionRegion adoptions={adoptions} view={scopeView} locale={props.locale} messages={props.messages} />;
}

/** The Work's recipe, prompt, skill or guide, laid out from the section its projection listed. */
export async function TypeExperience({ id, work, experience, locale, messages }: Common & { id: string; work: Header;
  experience: WorkExperience }) {
  const section = experience.typeSection;
  if (experience.kind === 'recipe' && section) {
    return recipeRegion({ host: await recipePageHost(), id, work, href: section.href, locale, messages });
  }
  if ((experience.kind === 'prompt' || experience.kind === 'skill') && section) {
    const hub = await readHubWorkPage(section.href);
    if (!hub) return null;
    if (!hub.ok) return <RegionFailure title={messages.hubUnavailable} failure={hub.failure} messages={messages} />;
    return hub.data ? <HubExperience page={hub.data} locale={locale} messages={messages} />
      : <Region id="hub-experience" title={messages.hubNotPublished}><p>{messages.hubNotPublished}</p></Region>;
  }
  if (experience.kind !== 'guide') return null;
  const text = await readText(work.mainVersion, work.selectedLanguage ?? undefined);
  if (!text.ok) return <RegionFailure title={messages.guideUnavailable} failure={text.failure} messages={messages} />;
  return <GuideExperience body={text.data.body} title={work.title.value} updatedAt={work.lastUpdatedAt}
    locale={locale} messages={messages} />;
}

/**
 * Overview: the hub's sections below the identity, in the documented order. Each region reads in parallel under
 * its own Suspense boundary; `OverviewLayout` draws only the sections the Work's projection binds.
 */
export async function WorkOverview({ workRef, id, work, scope, context, locale, messages, lead, client }: Common & {
  workRef: WorkAt; id: string; work: Header; scope: WorkScope | null; context: string | undefined;
  /** The sections a Zone's page leads with (`ZonePackage.hubOrder`). */
  lead?: readonly HubSection[];
}) {
  const [experience, plan] = await Promise.all([readExperience(id, work.types, client), readHubPlan(id, client)]);
  if (experience.kind === 'recipe') {
    return recipeWorkOverview({ host: await recipePageHost(), workRef, id, work, scope, locale, messages, lead });
  }
  const access = await readPlatformAccess(client);
  const t = messages;
  const loading = t.loadingRegion;
  const common = { id, locale, messages, client };
  const specialist = <Suspense fallback={<RegionSkeleton
    id="work-type-loading" title={work.title.value} label={loading} lines={5} />}>
    <TypeExperience id={id} work={work} experience={experience} locale={locale} messages={messages} /></Suspense>;
  return <OverviewLayout messages={messages} plan={plan} lead={lead}
    // Specialist reading or cooking leads; the description and tags follow.
    // A recipe returns above, through the shared recipe overview.
    type={experience.kind === 'prompt' || experience.kind === 'skill'
      ? operationOpen('getV1HubWorksById', access) ? <Suspense fallback={<RegionSkeleton
        id="work-type-loading" title={work.title.value} label={loading} lines={5} />}>
        <TypeExperience id={id} work={work} experience={experience} locale={locale} messages={messages} /></Suspense> : null
      : experience.kind === 'book' || experience.kind === 'plain' ? null : specialist}
    about={<WorkAbout work={work} locale={locale} messages={messages} />}
    availability={<>
      <Suspense fallback={<RegionSkeleton id="work-availability-loading" title={t.sectionAvailability} label={loading}
        lines={4} />}>
        {plan.includes('availability') ? (client ? Availability({ workRef, ...common }) : <Availability workRef={workRef} {...common} />) : null}</Suspense>
      <Suspense fallback={null}>{plan.includes('availability') ? (client
        ? WorkTypeSections({ work: id, types: work.types, locale })
        : <WorkTypeSections work={id} types={work.types} locale={locale} />) : null}</Suspense>
    </>}
    parts={<Suspense fallback={<RegionSkeleton id="work-parts-loading" title={t.sectionParts} label={loading} lines={3} />}>
      {plan.includes('parts') ? (client ? Parts({ workRef, ...common }) : <Parts workRef={workRef} {...common} />) : null}</Suspense>}
    wiki={<Suspense fallback={<RegionSkeleton id="work-wiki-loading" title={t.sectionWiki} label={loading} lines={2} />}>
      {plan.includes('wiki') ? (client ? WikiSection(common) : <WikiSection {...common} />) : null}</Suspense>}
    scopeBar={<Suspense fallback={<ScopeBarSkeleton label={loading} />}>
      {!scope && plan.includes('ratings') ? (client ? ScopeBarSlot({ workRef, id, scope, locale, messages, client }) : <ScopeBarSlot workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />) : null}
    </Suspense>}
    ratings={scope ? <Suspense fallback={<RegionSkeleton id="work-ratings-loading" title={t.ratings} label={loading}
      lines={5} />}>
      {plan.includes('ratings') ? (client ? Ratings({ workRef, id, scope, context, locale, messages, client }) : <Ratings workRef={workRef} id={id} scope={scope} context={context} locale={locale} messages={messages} />) : null}
    </Suspense> : null}
    classification={scope ? <Suspense fallback={<RegionSkeleton id="work-classification-loading"
      title={t.classification} label={loading} />}>
      {plan.includes('about') ? (client ? Classification({ workRef, id, scope, locale, messages, client }) : <Classification workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />) : null}
    </Suspense> : null}
    reviews={scope ? <Suspense fallback={<RegionSkeleton id="work-reviews-loading" title={t.reviews} label={loading}
      lines={6} />}>
      {plan.includes('ratings') ? (client ? Reviews({ workRef, id, work, scope, context, locale, messages, client }) : <Reviews workRef={workRef} id={id} work={work} scope={scope} context={context} locale={locale} messages={messages} />) : null}
    </Suspense> : null}
    discussion={<Suspense fallback={<RegionSkeleton id="work-discussion-loading" title={t.sectionDiscussion}
      label={loading} lines={3} />}>
      {plan.includes('discussion') ? (client ? DiscussionHub({ workRef, ...common }) : <DiscussionHub workRef={workRef} {...common} />) : null}</Suspense>}
    adoption={scope ? <Suspense fallback={<RegionSkeleton id="work-adoption-loading" title={t.adoption}
      label={loading} lines={2} />}>
      {plan.includes('discussion') ? (client ? Adoption({ workRef, id, scope, locale, messages, client }) : <Adoption workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />) : null}
    </Suspense> : null}
    record={null}
    alsoEnjoyed={<Suspense fallback={null}>
      {plan.includes('lists') ? (client ? AlsoEnjoyed({ id, work, locale, messages, client }) : <AlsoEnjoyed id={id} work={work} locale={locale} messages={messages} />) : null}</Suspense>}
    author={<Suspense fallback={null}>{plan.includes('lists') ? (client ? Author({ id, locale, messages, client }) : <Author id={id} locale={locale} messages={messages} />) : null}</Suspense>} />;
}

export async function WorkVersions({ workRef, id, query, locale, messages }: Common & {
  workRef: WorkAt; id: string; query: VersionQuery | null;
}) {
  const versions = query ? await readVersions(id, locale, query) : null;
  return <VersionsRegion versions={versions} workRef={workRef} query={query ?? {}} locale={locale} messages={messages} />;
}

export async function WorkHistory({ workRef, id, query, locale, messages }: Common & {
  workRef: WorkAt; id: string; query: { kind?: HistoryFilter; cursor?: string } | null;
}) {
  const history = query ? await readHistory(id, query.kind, query.cursor) : { ok: false as const, failure: 'invalid' as const };
  return <HistoryRegion history={history} workRef={workRef} kind={query?.kind} cursor={query?.cursor} locale={locale}
    messages={messages} />;
}

async function Discussion(props: ScopedProps & { cursor: string | undefined }) {
  const { id, scope, cursor } = props;
  const [scopeView, discussion, feedMessages] = await Promise.all([view(props), scope.kind === 'mine' ? null
    : readDiscussion(id, scope.kind === 'realm' ? scope.realm : undefined, cursor), getMessages('feed', props.locale)]);
  // Replies from Realms the adoption page did not name are named by their own public read.
  const unnamed = discussion?.ok ? [...new Set(discussion.data.items.flatMap(item => {
    const realm = idOf(item.realm);
    return realm && !scopeView.realms.some(entry => entry.id === realm) ? [realm] : [];
  }))] : [];
  const named = await Promise.all(unnamed.map(async realm => {
    const header = await readRealm(realm, props.locale);
    return { id: realm, name: header.ok ? header.data.name : null };
  }));
  return <DiscussionRegion discussion={discussion} view={{ ...scopeView, realms: [...scopeView.realms, ...named] }}
    cursor={cursor} locale={props.locale} messages={props.messages} feedMessages={feedMessages} />;
}

/** Discussion: the scope bar, then reviewed replies from every public Realm or the chosen one. */
export function WorkDiscussion({ workRef, id, scope, cursor, locale, messages }: Common & {
  workRef: WorkAt; id: string; scope: WorkScope | null; cursor: string | undefined;
}) {
  return <>
    <Suspense fallback={<ScopeBarSkeleton label={messages.loadingRegion} />}>
      <ScopeBarSlot workRef={workRef} id={id} scope={scope} tab="discussion" locale={locale} messages={messages} />
    </Suspense>
    {scope ? <Suspense fallback={<RegionSkeleton id="work-discussion-loading" title={messages.discussion}
      label={messages.loadingRegion} lines={6} />}>
      <Discussion workRef={workRef} id={id} scope={scope} cursor={cursor} locale={locale} messages={messages} />
    </Suspense> : <InvalidScope messages={messages} />}
  </>;
}

export async function WorkContents({ workRef, id, work, query, locale, messages, client }: Common & {
  workRef: WorkAt; id: string; work: Header; query: ContentsQuery | null;
}) {
  const contents = query ? await readContents(id, query, client) : { ok: false as const, failure: 'invalid' as const };
  const none = contents.ok ? !contents.data.items.length && !query?.parent && !query?.cursor
    : contents.failure === 'missing';
  const language = none ? await oneTextLanguage(id, locale, work.selectedLanguage, client) : null;
  // Called a book as its cover draws it: a Work with no type, such as an imported classic, is shown as one.
  const oneText = language ? { title: work.title, language, book: coverKindOf(work.types) === 'book' } : null;
  // The top level opens one volume with its chapters: the one asked for (the reader's), else the first story volume.
  const groups = contents.ok && query && !query.parent ? contents.data.items.filter(item => item.role === 'group') : [];
  const open = groups.find(item => idOf(item.occurrence) === query?.open)
    ?? groups.find(item => item.division !== 'extras' && item.childCount) ?? groups[0];
  const openPage = open && query ? await readContents(id, { parent: idOf(open.occurrence) ?? undefined,
    language: query.language }, client) : null;
  return <ContentsRegion contents={contents} workRef={workRef} id={id} query={query ?? {}} oneText={oneText}
    opened={open && openPage?.ok ? { occurrence: open.occurrence, page: openPage.data } : null}
    groupAction={readContentsGroup} locale={locale} messages={messages} />;
}
