import { headers } from 'next/headers';
import { materializeData } from 'native-i18n';
import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { browseReader } from '../discover/server.ts';
import { lifespan } from '../author/facts.ts';
import { authorHref } from '../author/route.ts';
import { messages as authorMessages } from '../author/messages.ts';
import authorZhHans from '../author/messages/zh-Hans.ts';
import { readOpenLibraryAuthor, readOpenLibraryAuthorWorks } from '../author/read.ts';
import { authorSeparator, coverKindOf } from '../catalogue/work.ts';
import { AdoptionRegion } from './adoption.tsx';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import { AuthorSection } from './author.tsx';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import { readFacets } from '../concept/read.ts';
import { ClassificationRegion, type CommunityGenres } from './classification.tsx';
import { WorkCredits, WorkCreditsSkeleton } from './credits.tsx';
import { HistoryRegion } from './history.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import { readContentsGroup } from './contents-actions.ts';
import { ContentsRegion } from './contents.tsx';
import { DiscussionRegion } from './discussion.tsx';
import { editionMessages, EditionsSection } from './editions.tsx';
import { oneTextLanguage, readAdoptions, readAgentCredits, readAgentWorks, readAlsoEnjoyed, readClassifications,
  readReleases,
  readContents, readCredits, readDiscussion, readHistory, readingAgent, readRatings, readReaderState, readRealm,
  readReviewer, readReviews, readStart, readVersions, readWorkStats, readRecipeWorkPage,
  readHubWorkPage, readText } from './read.ts';
import { Region, RegionFailure, RegionSkeleton } from './region.tsx';
import { WorkRecord } from './record.tsx';
import { type ContentsQuery, EVERYONE, type HistoryFilter, idOf, type VersionQuery, type WorkScope, workHref }
  from './route.ts';
import { ScopeBar, ScopeBarSkeleton, type ScopeRealm, type ScopeView } from './scope-bar.tsx';
import { ReviewsSection } from './reviews.tsx';
import type { WorkHeader as Header, Reviewer } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { InvalidScope, OverviewLayout, ReadButton, WorkFrame, WorkPageCover } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';
import { WorkTypeSections } from '../zones/work-sections.tsx';
import { WorkKindActions } from './types/actions.tsx';
import { workPageKind } from './types/kind.ts';
import { RecipeExperience } from './types/recipe.tsx';
import { HubExperience } from './types/hub.tsx';
import { GuideExperience } from './types/guide.tsx';

// Server compositions for the `/w/[ref]` routes: each region reads Main on its
// own under Suspense, so the page streams as answers arrive and one failure
// stays in its region.

interface Common { locale: UiLocale; messages: WorkPageMessages }

/** Realms the scope bar and empty states can offer: those that adopted the Work, plus the one in the URL. */
async function scopeRealms(id: string, scope: WorkScope | null, locale: UiLocale): Promise<ScopeRealm[]> {
  const [adoptions, current] = await Promise.all([readAdoptions(id, locale),
    scope?.kind === 'realm' ? readRealm(scope.realm, locale) : null]);
  const realms: ScopeRealm[] = adoptions.ok ? adoptions.data.items.flatMap(item => {
    const realm = idOf(item.realm);
    return realm ? [{ id: realm, name: item.name }] : [];
  }) : [];
  if (scope?.kind === 'realm' && !realms.some(realm => realm.id === scope.realm)) {
    realms.unshift({ id: scope.realm, name: current?.ok ? current.data.name : null });
  }
  return realms;
}

async function Credits({ id, locale, messages }: Common & { id: string }) {
  const [agentCredits, credits] = await Promise.all([readAgentCredits(id), readCredits(id)]);
  return <WorkCredits agentCredits={agentCredits} credits={credits} locale={locale} messages={messages} />;
}

/** The cover uses the same credited names as the header, without delaying the rest of the Work page. */
async function Cover({ id, work, avatarQuery, locale, messages }: Common & {
  id: string; work: Header; avatarQuery?: string;
}) {
  const [agentCredits, externalCredits] = await Promise.all([readAgentCredits(id), readCredits(id)]);
  const t = materializeData(messages, { locale });
  const authors = [
    ...(agentCredits.ok ? agentCredits.data.items.filter(credit => credit.role === 'author')
      .map(credit => ({ name: credit.displayName, href: authorHref({ kind: 'agent', handle: credit.handle }) })) : []),
    ...(externalCredits.ok ? externalCredits.data.items.filter(credit => credit.role === 'author')
      .sort((a, b) => a.ordinal - b.ordinal).map(credit => ({
        name: credit.displayName ?? t.openLibraryAuthor({ key: credit.key.replace(/^\/authors\//, '') }),
        href: credit.provider === 'open-library' ? authorHref({ kind: 'external', key: credit.key }) : null })) : []),
  ];
  return <WorkPageCover work={work} authors={authors} avatarQuery={avatarQuery} />;
}

/**
 * Everyone's rating summary for the header, on the Work's first rating
 * question, with its reviews and the people reading the Work now.
 */
async function RatingLineSlot({ id, locale, messages }: Common & { id: string }) {
  const ratings = await readRatings(id, EVERYONE, undefined);
  const stats = await readWorkStats(id, ratings.ok ? ratings.data.context?.context : undefined);
  return <RatingLine ratings={ratings} stats={stats} locale={locale} messages={messages} />;
}

/** A type's primary action, or the next readable chapter for books. */
async function ReadSlot({ workRef, id, work, locale, messages }: Common & { workRef: string; id: string;
  work: Header }) {
  const kind = workPageKind(work.types);
  if (kind !== 'book') {
    const hub = kind === 'prompt' || kind === 'skill' ? await readHubWorkPage(id) : null;
    return <WorkKindActions kind={kind} workId={work.id} title={work.title.value} locale={locale}
      messages={messages} hubText={hub?.ok ? hub.data?.content ?? null : null} />;
  }
  return <ReadButton workRef={workRef} start={await readStart(id, work.id, locale, work.selectedLanguage)}
    messages={messages} />;
}

/** Header and tabs around every Work view; credits and the rating summary stream in on their own. */
export async function WorkFrameView({ workRef, id, work, locale, messages, children }: Common & {
  workRef: string; id: string; work: Header; children: ReactNode;
}) {
  const [{ signedIn, actingSubject }, { avatarQuery }, seed, ratings] = await Promise.all([readingAgent(), browseReader(),
    readReaderState(id), readRatings(id, EVERYONE, undefined)]);
  // The stars answer everyone's first rating question for the Main Version shown, as the summary above them does.
  const context = ratings.ok ? ratings.data.context : null;
  const ratingTarget = context ? { work: work.id, context: context.context, mainVersion: work.mainVersion,
    max: context.scale.max } : null;
  return <WorkFrame workRef={workRef} work={work} locale={locale} messages={messages} signedIn={signedIn}
    actingSubject={seed ? actingSubject : null} readerSeed={seed ?? undefined} ratingTarget={ratingTarget}
    signInHref={signInPath(localizedPath(workHref(workRef), locale))} avatarQuery={avatarQuery}
    cover={<Suspense fallback={<WorkPageCover work={work} avatarQuery={avatarQuery} />}>
      <Cover id={id} work={work} avatarQuery={avatarQuery} locale={locale} messages={messages} /></Suspense>}
    credits={<Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      <Credits id={id} locale={locale} messages={messages} /></Suspense>}
    ratingLine={<Suspense fallback={null}><RatingLineSlot id={id} locale={locale} messages={messages} /></Suspense>}
    readAction={<Suspense fallback={workPageKind(work.types) === 'book'
      ? <ReadButton workRef={workRef} start={{ kind: 'contents' }} messages={messages} /> : null}>
      <ReadSlot workRef={workRef} id={id} work={work} locale={locale} messages={messages} /></Suspense>}>
    {children}</WorkFrame>;
}

async function ScopeBarSlot({ workRef, id, scope, tab = 'overview', locale, messages }: Common & {
  workRef: string; id: string; scope: WorkScope | null; tab?: 'overview' | 'discussion';
}) {
  return <ScopeBar workRef={workRef} scope={scope} realms={await scopeRealms(id, scope, locale)} tab={tab}
    locale={locale} messages={messages} />;
}

type ScopedProps = Common & { workRef: string; id: string; scope: WorkScope };

async function view({ workRef, id, scope, locale }: ScopedProps): Promise<ScopeView> {
  return { workRef, scope, realms: await scopeRealms(id, scope, locale) };
}

async function Ratings(props: ScopedProps & { context: string | undefined }) {
  const [scopeView, ratings] = await Promise.all([view(props), readRatings(props.id, props.scope, props.context)]);
  return <RatingSummaryRegion ratings={ratings} view={scopeView} locale={props.locale} messages={props.messages}
    scopeBar={<ScopeBar workRef={props.workRef} scope={props.scope} realms={scopeView.realms} locale={props.locale}
      messages={props.messages} />} />;
}

/**
 * Details with a citation: the title, native authors, REZICS and the page's
 * address in this interface language, from the proxy's record of the request.
 */
async function Record({ id, workRef, work, locale, messages }: Common & { id: string; workRef: string; work: Header }) {
  const [credits, page] = await Promise.all([readAgentCredits(id), headers().then(list => list.get('x-rezics-page-url'))]);
  const authors = credits.ok ? credits.data.items.filter(credit => credit.role === 'author').map(credit => credit.displayName)
    : [];
  const url = page ? new URL(localizedPath(workHref(workRef), locale), page).toString() : null;
  const citation = url ? [work.title.value, authors.join(authorSeparator(authors)), 'REZICS', url]
    .filter(Boolean).join('. ') : undefined;
  return <WorkRecord work={work} citation={citation} locale={locale} messages={messages} />;
}

async function Author({ id, locale, messages }: Common & { id: string }) {
  const [agents, external] = await Promise.all([readAgentCredits(id), readCredits(id)]);
  const native = agents.ok ? agents.data.items.find(credit => credit.role === 'author') : undefined;
  if (native) {
    const [works, { avatarQuery }] = await Promise.all([readAgentWorks(native.agent, locale), browseReader()]);
    return <AuthorSection author={{ kind: 'agent', name: native.displayName, handle: native.handle, works }}
      work={id} avatarQuery={avatarQuery} locale={locale} messages={messages} />;
  }
  const credit = external.ok ? [...external.data.items].filter(item => item.role === 'author')
    .sort((a, b) => a.ordinal - b.ordinal)[0] : undefined;
  if (!credit || credit.provider !== 'open-library' || !credit.key) return null;
  const [details, works, { avatarQuery }] = await Promise.all([
    readOpenLibraryAuthor(credit.key, locale, 1), readOpenLibraryAuthorWorks(credit.key, locale, 12), browseReader(),
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
async function Reviews({ workRef, id, work, scope, context: chosen, locale, messages }: ScopedProps & {
  work: Header; context: string | undefined }) {
  const [ratings, everyone, { signedIn, actingSubject }] = await Promise.all([
    readRatings(id, scope.kind === 'mine' ? EVERYONE : scope, chosen),
    readRatings(id, EVERYONE, undefined), readingAgent()]);
  const question = ratings.ok ? ratings.data.context : null;
  if (!question) return null;
  const initial = await readReviews(id, { context: question.context, sort: 'helpful', limit: 10 });
  const authors = initial.ok ? [...new Set(initial.data.items.map(review => review.author))] : [];
  const named = await Promise.all(authors.map(async author => [author, await readReviewer(author)] as const));
  const writable = everyone.ok && everyone.data.context?.context === question.context;
  return <ReviewsSection work={work.id} context={question.context} scale={question.scale.max} initial={initial}
    reviewers={Object.fromEntries(named.filter((entry): entry is [string, Reviewer] => entry[1] !== null))}
    viewer={actingSubject ? { kind: 'reader', actingSubject, canWrite: writable }
      : signedIn ? { kind: 'no-identity' }
        : { kind: 'signed-out', signInHref: signInPath(localizedPath(workHref(workRef), locale)) }}
    locale={locale} messages={messages} />;
}

async function Classification(props: ScopedProps) {
  const [scopeView, classifications, facets] = await Promise.all([view(props), props.scope.kind === 'mine' ? null
    : readClassifications(props.id, props.locale, props.scope), readFacets()]);
  const facet = classificationFacet(facets.ok ? facets.data : null);
  // Nobody tagged it for everyone: show what the first two communities featuring it chose, named as theirs.
  const untagged = props.scope.kind === 'global' && classifications?.ok && !classifications.data.items.length;
  const communities: CommunityGenres[] = untagged ? await Promise.all(scopeView.realms.slice(0, 2).map(async realm => {
    const chosen = await readClassifications(props.id, props.locale, { kind: 'realm', realm: realm.id });
    return { realm, items: chosen.ok ? chosen.data.items.filter(item => item.source === 'local') : [] };
  })) : [];
  return <ClassificationRegion classifications={classifications} view={scopeView} communities={communities}
    facet={facet ? { id: facet.id, label: facetLabel(facet, props.locale) } : null}
    locale={props.locale} messages={props.messages} />;
}

/** Works to read next, beside the ones this Work's readers also enjoyed. */
async function Editions({ id, locale, messages }: Common & { id: string }) {
  const releases = await readReleases(id);
  if (!releases.ok) return <EditionsSection items={null} failure={releases.failure} locale={locale} messages={messages} />;
  return <EditionsSection items={releases.data.items} failure={null} locale={locale} messages={messages} />;
}

async function AlsoEnjoyed({ id, work, locale, messages }: Common & { id: string; work: Header }) {
  const [alsoEnjoyed, realms, { avatarQuery }] = await Promise.all([readAlsoEnjoyed(id, locale),
    scopeRealms(id, null, locale), browseReader()]);
  return <AlsoEnjoyedSection alsoEnjoyed={alsoEnjoyed} book={coverKindOf(work.types) === 'book'} realms={realms}
    avatarQuery={avatarQuery} locale={locale} messages={messages} />;
}

async function Adoption(props: ScopedProps) {
  const [scopeView, adoptions] = await Promise.all([view(props), readAdoptions(props.id, props.locale)]);
  return <AdoptionRegion adoptions={adoptions} view={scopeView} locale={props.locale} messages={props.messages} />;
}

async function TypeExperience({ id, work, locale, messages }: Common & { id: string; work: Header }) {
  const kind = workPageKind(work.types);
  if (kind === 'book') return null;
  if (kind === 'recipe') {
    const [recipe, text, agent] = await Promise.all([readRecipeWorkPage(id),
      readText(work.mainVersion, work.selectedLanguage ?? undefined), readingAgent()]);
    if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
    return <RecipeExperience initial={recipe.data} workId={id} actingSubject={agent.actingSubject}
      text={text.ok ? text.data.body : null} locale={locale} messages={messages} />;
  }
  if (kind === 'prompt' || kind === 'skill') {
    const hub = await readHubWorkPage(id);
    if (!hub.ok) return <RegionFailure title={messages.hubUnavailable} failure={hub.failure} messages={messages} />;
    return hub.data ? <HubExperience page={hub.data} locale={locale} messages={messages} />
      : <Region id="hub-experience" title={messages.hubNotPublished}><p>{messages.hubNotPublished}</p></Region>;
  }
  const text = await readText(work.mainVersion, work.selectedLanguage ?? undefined);
  if (!text.ok) return <RegionFailure title={messages.guideUnavailable} failure={text.failure} messages={messages} />;
  return <GuideExperience body={text.data.body} title={work.title.value} updatedAt={work.lastUpdatedAt}
    locale={locale} messages={messages} />;
}

/** Overview: each region reads in parallel under its own Suspense boundary. */
export function WorkOverview({ workRef, id, work, scope, context, locale, messages }: Common & {
  workRef: string; id: string; work: Header; scope: WorkScope | null; context: string | undefined;
}) {
  const t = messages;
  const loading = t.loadingRegion;
  // Specialist reading or cooking leads; shared type sections follow the description.
  return <OverviewLayout messages={messages} about={<div className="grid gap-8">
    {workPageKind(work.types) === 'book' ? null : <Suspense fallback={<RegionSkeleton
      id="work-type-loading" title={work.title.value} label={loading} lines={5} />}>
      <TypeExperience id={id} work={work} locale={locale} messages={messages} /></Suspense>}
    <WorkAbout work={work} messages={messages} />
    <Suspense fallback={<RegionSkeleton id="work-editions-loading" title={editionMessages[locale].editions}
      label={loading} lines={4} />}>
      <Editions id={id} locale={locale} messages={messages} /></Suspense>
    <Suspense fallback={null}><WorkTypeSections work={id} types={work.types} locale={locale} /></Suspense>
  </div>}
    scopeBar={<Suspense fallback={<ScopeBarSkeleton label={loading} />}>
      <ScopeBarSlot workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense>}
    ratings={scope ? <Suspense fallback={<RegionSkeleton id="work-ratings-loading" title={t.ratings} label={loading}
      lines={5} />}>
      <Ratings workRef={workRef} id={id} scope={scope} context={context} locale={locale} messages={messages} />
    </Suspense> : null}
    classification={scope ? <Suspense fallback={<RegionSkeleton id="work-classification-loading"
      title={t.classification} label={loading} />}>
      <Classification workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense> : null}
    reviews={scope ? <Suspense fallback={<RegionSkeleton id="work-reviews-loading" title={t.reviews} label={loading}
      lines={6} />}>
      <Reviews workRef={workRef} id={id} work={work} scope={scope} context={context} locale={locale}
        messages={messages} />
    </Suspense> : null}
    adoption={scope ? <Suspense fallback={<RegionSkeleton id="work-adoption-loading" title={t.adoption}
      label={loading} lines={2} />}>
      <Adoption workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense> : null}
    record={<Suspense fallback={<WorkRecord work={work} locale={locale} messages={messages} />}>
      <Record id={id} workRef={workRef} work={work} locale={locale} messages={messages} /></Suspense>}
    alsoEnjoyed={<Suspense fallback={null}>
      <AlsoEnjoyed id={id} work={work} locale={locale} messages={messages} /></Suspense>}
    author={<Suspense fallback={null}><Author id={id} locale={locale} messages={messages} /></Suspense>} />;
}

export async function WorkVersions({ workRef, id, query, locale, messages }: Common & {
  workRef: string; id: string; query: VersionQuery | null;
}) {
  const versions = query ? await readVersions(id, locale, query) : null;
  return <VersionsRegion versions={versions} workRef={workRef} query={query ?? {}} locale={locale} messages={messages} />;
}

export async function WorkHistory({ workRef, id, query, locale, messages }: Common & {
  workRef: string; id: string; query: { kind?: HistoryFilter; cursor?: string } | null;
}) {
  const history = query ? await readHistory(id, query.kind, query.cursor) : { ok: false as const, failure: 'invalid' as const };
  return <HistoryRegion history={history} workRef={workRef} kind={query?.kind} cursor={query?.cursor} locale={locale}
    messages={messages} />;
}

async function Discussion(props: ScopedProps & { cursor: string | undefined }) {
  const { id, scope, cursor } = props;
  const [scopeView, discussion] = await Promise.all([view(props), scope.kind === 'mine' ? null
    : readDiscussion(id, scope.kind === 'realm' ? scope.realm : undefined, cursor)]);
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
    cursor={cursor} locale={props.locale} messages={props.messages} />;
}

/** Discussion: the scope bar, then reviewed replies from every public Realm or the chosen one. */
export function WorkDiscussion({ workRef, id, scope, cursor, locale, messages }: Common & {
  workRef: string; id: string; scope: WorkScope | null; cursor: string | undefined;
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

export async function WorkContents({ workRef, id, work, query, locale, messages }: Common & {
  workRef: string; id: string; work: Header; query: ContentsQuery | null;
}) {
  const contents = query ? await readContents(id, query) : { ok: false as const, failure: 'invalid' as const };
  const none = contents.ok ? !contents.data.items.length && !query?.parent && !query?.cursor
    : contents.failure === 'missing';
  const language = none ? await oneTextLanguage(id, locale, work.selectedLanguage) : null;
  // Called a book as its cover draws it: a Work with no type, such as an imported classic, is shown as one.
  const oneText = language ? { title: work.title, language, book: coverKindOf(work.types) === 'book' } : null;
  // The top level opens one volume with its chapters: the one asked for (the reader's), else the first story volume.
  const groups = contents.ok && query && !query.parent ? contents.data.items.filter(item => item.role === 'group') : [];
  const open = groups.find(item => idOf(item.occurrence) === query?.open)
    ?? groups.find(item => item.division !== 'extras' && item.childCount) ?? groups[0];
  const openPage = open && query ? await readContents(id, { parent: idOf(open.occurrence) ?? undefined,
    language: query.language }) : null;
  return <ContentsRegion contents={contents} workRef={workRef} id={id} query={query ?? {}} oneText={oneText}
    opened={open && openPage?.ok ? { occurrence: open.occurrence, page: openPage.data } : null}
    groupAction={readContentsGroup} locale={locale} messages={messages} />;
}
