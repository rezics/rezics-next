import { headers } from 'next/headers';
import { materializeData } from 'native-i18n';
import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
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
import { ProvisionalNotice } from '../catalogue-intake/provisional-notice.tsx';
import { ContentsRegion } from './contents.tsx';
import { DiscussionRegion } from './discussion.tsx';
import { oneTextLanguage, readAdoptions, readAgentCredits, readAgentWorks, readAlsoEnjoyed, readClassifications,
  readContents, readCredits, readDiscussion, readHistory, readingAgent, readRatings, readReaderState, readRealm,
  readReviewer, readReviews, readVersions, readWorkStats, readRecipeWorkPage,
  readHubWorkPage, readText, readRatingPopulations } from './read.ts';
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
import { readOwnWorkShowcase } from '../api/showcase.ts';
import { workShowcaseHeader } from '../showcase/work-header.tsx';
import { WorkTypeSections } from '../zones/work-sections.tsx';
import { AboutFacts, Availability, DiscussionHub, Parts, PrimaryAction, Status } from './hub-sections.tsx';
import { type HubSection, hubLabels, hubPlan } from './hub.ts';
import { WikiSection, WikiShortcut } from './wiki-server.tsx';
import { readEntityProjection } from '../entity-page/read.ts';
import { type WorkExperience, workExperience } from '../entity-page/experience.ts';
import { shelfWords } from './shelf-words.ts';
import { WorkKindActions } from './types/actions.tsx';
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

async function ratingRealms(id: string, scope: WorkScope | null, locale: UiLocale): Promise<ScopeRealm[]> {
  const [populations, current] = await Promise.all([readRatingPopulations(id, locale),
    scope?.kind === 'realm' ? readRealm(scope.realm, locale) : null]);
  const realms: ScopeRealm[] = populations.ok ? populations.data.items.filter(item => !item.global)
    .map(item => ({ id: item.id.slice(-36), name: item.name, ratingCount: item.ratingCount, readerCommunity: item.readerCommunity })) : [];
  if (scope?.kind === 'realm' && !realms.some(realm => realm.id === scope.realm)) {
    realms.push({ id: scope.realm, name: current?.ok ? current.data.name : null });
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
      .map(credit => ({ name: credit.displayName, href: authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent }) })) : []),
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

/**
 * The page a Work gets: its registry presentation and type section, from its
 * `entity-page-v1` projection (read once per request). When Main cannot serve
 * the projection the registry's entry for the Work's types stands in and the
 * type section is left out.
 */
export const readExperience = async (id: string, types: readonly string[]): Promise<WorkExperience> => {
  const page = await readEntityProjection(id);
  return workExperience(page.ok ? page.data : null, types);
};

/** A type's own action (cook, copy, install), or for cover-led Works the one primary action the hub leads with. */
async function ReadSlot({ workRef, id, work, experience, locale, messages }: Common & { workRef: WorkAt; id: string;
  work: Header; experience: WorkExperience }) {
  if (experience.kind === 'book') {
    return <PrimaryAction workRef={workRef} id={id} work={work} locale={locale} messages={messages} />;
  }
  const hub = experience.typeSection && experience.kind !== 'recipe' ? await readHubWorkPage(experience.typeSection.href)
    : null;
  return <WorkKindActions kind={experience.kind} workId={work.id} title={work.title.value} locale={locale}
    messages={messages} hubText={hub?.ok ? hub.data?.content ?? null : null}
    words={shelfWords(experience, messages)} />;
}

/** The hub sections the Work's projection binds, in the documented order. */
export const readHubPlan = async (id: string): Promise<readonly HubSection[]> => {
  const page = await readEntityProjection(id);
  return hubPlan(page.ok ? page.data : null);
};

/** Header and tabs around every Work view; credits and the rating summary stream in on their own. */
export async function WorkFrameView({ workRef, id, work, locale, messages, lead, children }: Common & {
  workRef: WorkAt; id: string; work: Header; children: ReactNode;
  /** The sections a Zone's page leads with (`ZonePackage.hubOrder`). */
  lead?: readonly HubSection[];
}) {
  const [{ signedIn, actingSubject }, { avatarQuery }, seed, ratings, experience, plan, art, showcaseMessages] = await Promise.all([
    readingAgent(), browseReader(), readReaderState(id), readRatings(id, EVERYONE, undefined), readExperience(id, work.types),
    readHubPlan(id),
    // One batch for the page, so the art costs one round trip however many layers it has.
    readOwnWorkShowcase(work.id), getMessages('showcase', locale)]);
  // The stars answer everyone's first rating question for the Main Version shown, as the summary above them does.
  const context = ratings.ok ? ratings.data.context : null;
  const ratingTarget = context ? { work: work.id, context: context.context, mainVersion: work.mainVersion,
    max: context.scale.max } : null;
  return <WorkFrame workRef={workRef} work={work} experience={experience} locale={locale} messages={messages} signedIn={signedIn}
    showcase={workShowcaseHeader(art.get(work.id), showcaseMessages)}
    actingSubject={seed ? actingSubject : null} readerSeed={seed ?? undefined} ratingTarget={ratingTarget}
    signInHref={signInPath(localizedPath(workHref(workRef), locale))} avatarQuery={avatarQuery}
    cover={<Suspense fallback={<WorkPageCover work={work} avatarQuery={avatarQuery} />}>
      <Cover id={id} work={work} avatarQuery={avatarQuery} locale={locale} messages={messages} /></Suspense>}
    credits={<Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      <Credits id={id} locale={locale} messages={messages} /></Suspense>}
    ratingLine={<Suspense fallback={null}><RatingLineSlot id={id} locale={locale} messages={messages} /></Suspense>}
    sections={hubLabels(messages, plan, lead)}
    readAction={<Suspense fallback={experience.kind === 'book'
      ? <ReadButton workRef={workRef} start={{ kind: 'contents' }} messages={messages} /> : null}>
      <ReadSlot workRef={workRef} id={id} work={work} experience={experience} locale={locale} messages={messages} />
    </Suspense>}
    status={experience.kind === 'book' ? <Suspense fallback={null}>
      <Status id={id} locale={locale} messages={messages} /></Suspense> : undefined}
    shortcuts={<>
      <ProvisionalNotice verification={work.verification} provenance={work.fieldProvenance} locale={locale} />
      {plan.includes('wiki') ? <Suspense fallback={null}>
        <WikiShortcut id={id} locale={locale} messages={messages} /></Suspense> : null}</>}>
    {children}</WorkFrame>;
}

async function ScopeBarSlot({ workRef, id, scope, tab = 'overview', locale, messages }: Common & {
  workRef: WorkAt; id: string; scope: WorkScope | null; tab?: 'overview' | 'discussion';
}) {
  const [realms, agent] = await Promise.all([tab === 'overview' ? ratingRealms(id, scope, locale) : scopeRealms(id, scope, locale), readingAgent()]);
  return <ScopeBar workRef={workRef} scope={scope} realms={realms} tab={tab}
    target={tab === 'overview' ? `https://rezics.com/id/${id}` : undefined} actingSubject={agent.actingSubject ?? undefined}
    locale={locale} messages={messages} />;
}

type ScopedProps = Common & { workRef: WorkAt; id: string; scope: WorkScope };

async function view({ workRef, id, scope, locale }: ScopedProps): Promise<ScopeView> {
  return { workRef, scope, realms: await scopeRealms(id, scope, locale) };
}

async function Ratings(props: ScopedProps & { context: string | undefined }) {
  const [realms, ratings, agent] = await Promise.all([ratingRealms(props.id, props.scope, props.locale),
    readRatings(props.id, props.scope, props.context), readingAgent()]);
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
async function Record({ id, workRef, work, locale, messages }: Common & { id: string; workRef: WorkAt; work: Header }) {
  const [credits, page] = await Promise.all([readAgentCredits(id), headers().then(list => list.get('x-rezics-page-url'))]);
  const authors = credits.ok ? credits.data.items.filter(credit => credit.role === 'author').map(credit => credit.displayName)
    : [];
  // A citation names the Work's own address, never a Zone's frame around it.
  const url = page ? new URL(localizedPath(workHref(workRefOf(workRef)), locale), page).toString() : null;
  const citation = url ? [work.title.value, authors.join(authorSeparator(authors)), 'REZICS', url]
    .filter(Boolean).join('. ') : undefined;
  return <WorkRecord work={work} citation={citation} locale={locale} messages={messages} />;
}

async function Author({ id, locale, messages }: Common & { id: string }) {
  const [agents, external] = await Promise.all([readAgentCredits(id), readCredits(id)]);
  const native = agents.ok ? agents.data.items.find(credit => credit.role === 'author') : undefined;
  if (native) {
    const [works, { avatarQuery }] = await Promise.all([readAgentWorks(native.agent, locale), browseReader()]);
    return <AuthorSection author={{ kind: 'agent', name: native.displayName, handle: native.handle, agent: native.agent, works }}
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
  // Editions, translations and related Works have their own rating questions, read in the scope the reviews are in.
  const targets = await reviewTargets(id, work, locale);
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

/** The Work's recipe, prompt, skill or guide, laid out from the section its projection listed. */
async function TypeExperience({ id, work, experience, locale, messages }: Common & { id: string; work: Header;
  experience: WorkExperience }) {
  const section = experience.typeSection;
  if (experience.kind === 'recipe' && section) {
    const [recipe, text, agent] = await Promise.all([readRecipeWorkPage(section.href),
      readText(work.mainVersion, work.selectedLanguage ?? undefined), readingAgent()]);
    if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
    return <RecipeExperience initial={recipe.data} href={section.href} actingSubject={agent.actingSubject}
      text={text.ok ? text.data.body : null} locale={locale} messages={messages} />;
  }
  if ((experience.kind === 'prompt' || experience.kind === 'skill') && section) {
    const hub = await readHubWorkPage(section.href);
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
export async function WorkOverview({ workRef, id, work, scope, context, locale, messages, lead }: Common & {
  workRef: WorkAt; id: string; work: Header; scope: WorkScope | null; context: string | undefined;
  /** The sections a Zone's page leads with (`ZonePackage.hubOrder`). */
  lead?: readonly HubSection[];
}) {
  const [experience, plan] = await Promise.all([readExperience(id, work.types), readHubPlan(id)]);
  const t = messages;
  const loading = t.loadingRegion;
  const common = { id, locale, messages };
  return <OverviewLayout messages={messages} plan={plan} lead={lead}
    // Specialist reading or cooking leads; the description and tags follow.
    type={experience.kind === 'book' || experience.kind === 'plain' ? null : <Suspense fallback={<RegionSkeleton
      id="work-type-loading" title={work.title.value} label={loading} lines={5} />}>
      <TypeExperience id={id} work={work} experience={experience} locale={locale} messages={messages} /></Suspense>}
    about={<WorkAbout work={work} messages={messages} />}
    facts={<Suspense fallback={null}><AboutFacts {...common} /></Suspense>}
    availability={<>
      <Suspense fallback={<RegionSkeleton id="work-availability-loading" title={t.sectionAvailability} label={loading}
        lines={4} />}>
        <Availability workRef={workRef} {...common} /></Suspense>
      <Suspense fallback={null}><WorkTypeSections work={id} types={work.types} locale={locale} /></Suspense>
    </>}
    parts={<Suspense fallback={<RegionSkeleton id="work-parts-loading" title={t.sectionParts} label={loading} lines={3} />}>
      <Parts workRef={workRef} {...common} /></Suspense>}
    wiki={<Suspense fallback={<RegionSkeleton id="work-wiki-loading" title={t.sectionWiki} label={loading} lines={2} />}>
      <WikiSection {...common} /></Suspense>}
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
    discussion={<Suspense fallback={<RegionSkeleton id="work-discussion-loading" title={t.sectionDiscussion}
      label={loading} lines={3} />}>
      <DiscussionHub workRef={workRef} {...common} /></Suspense>}
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

export async function WorkContents({ workRef, id, work, query, locale, messages }: Common & {
  workRef: WorkAt; id: string; work: Header; query: ContentsQuery | null;
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
