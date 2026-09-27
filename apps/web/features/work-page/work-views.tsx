import { headers } from 'next/headers';
import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { browseReader } from '../discover/server.ts';
import { AdoptionRegion } from './adoption.tsx';
import { AuthorSection } from './author.tsx';
import { ClassificationRegion } from './classification.tsx';
import { WorkCredits, WorkCreditsSkeleton } from './credits.tsx';
import { HistoryRegion } from './history.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import { ContentsRegion } from './contents.tsx';
import { DiscussionRegion } from './discussion.tsx';
import { readAdoptions, readAgentCredits, readAgentWorks, readClassifications, readContents, readCredits,
  readDiscussion, readHistory, readingAgent, readRatings, readReaderState, readRealm, readVersions } from './read.ts';
import { RegionSkeleton } from './region.tsx';
import { WorkRecord } from './record.tsx';
import { type ContentsQuery, type HistoryFilter, idOf, type VersionQuery, type WorkScope, workHref } from './route.ts';
import { ScopeBar, ScopeBarSkeleton, type ScopeRealm, type ScopeView } from './scope-bar.tsx';
import type { WorkHeader as Header } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { InvalidScope, OverviewLayout, WorkFrame } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';

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

/** Everyone's rating summary for the header, on the Work's first rating question. */
async function RatingLineSlot({ id, locale, messages }: Common & { id: string }) {
  return <RatingLine ratings={await readRatings(id, { kind: 'global' }, undefined)} locale={locale} messages={messages} />;
}

/** Header and tabs around every Work view; credits and the rating summary stream in on their own. */
export async function WorkFrameView({ workRef, id, work, locale, messages, children }: Common & {
  workRef: string; id: string; work: Header; children: ReactNode;
}) {
  const [{ signedIn, actingSubject }, { avatarQuery }, seed, ratings] = await Promise.all([readingAgent(), browseReader(),
    readReaderState(id), readRatings(id, { kind: 'global' }, undefined)]);
  // The stars answer everyone's first rating question for the Main Version shown, as the summary above them does.
  const context = ratings.ok ? ratings.data.context : null;
  const ratingTarget = context ? { work: work.id, context: context.context, mainVersion: work.mainVersion,
    max: context.scale.max } : null;
  return <WorkFrame workRef={workRef} work={work} locale={locale} messages={messages} signedIn={signedIn}
    actingSubject={seed ? actingSubject : null} readerSeed={seed ?? undefined} ratingTarget={ratingTarget}
    signInHref={signInPath(localizedPath(workHref(workRef), locale))} avatarQuery={avatarQuery}
    credits={<Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      <Credits id={id} locale={locale} messages={messages} /></Suspense>}
    ratingLine={<Suspense fallback={null}><RatingLineSlot id={id} locale={locale} messages={messages} /></Suspense>}>
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
  const citation = url ? [work.title.value, authors.join(', '), 'REZICS', url].filter(Boolean).join('. ') : undefined;
  return <WorkRecord work={work} citation={citation} locale={locale} messages={messages} />;
}

async function Author({ id, locale, messages }: Common & { id: string }) {
  const credits = await readAgentCredits(id);
  const author = credits.ok ? credits.data.items.find(credit => credit.role === 'author') : undefined;
  if (!author) return null;
  const [works, { avatarQuery }] = await Promise.all([readAgentWorks(author.agent, locale), browseReader()]);
  return <AuthorSection credit={author} works={works} work={id} avatarQuery={avatarQuery} locale={locale}
    messages={messages} />;
}

async function Classification(props: ScopedProps) {
  const [scopeView, classifications] = await Promise.all([view(props), props.scope.kind === 'mine' ? null
    : readClassifications(props.id, props.locale, props.scope)]);
  return <ClassificationRegion classifications={classifications} view={scopeView} locale={props.locale}
    messages={props.messages} />;
}

async function Adoption(props: ScopedProps) {
  const [scopeView, adoptions] = await Promise.all([view(props), readAdoptions(props.id, props.locale)]);
  return <AdoptionRegion adoptions={adoptions} view={scopeView} locale={props.locale} messages={props.messages} />;
}

/** Overview: each region reads in parallel under its own Suspense boundary. */
export function WorkOverview({ workRef, id, work, scope, context, locale, messages }: Common & {
  workRef: string; id: string; work: Header; scope: WorkScope | null; context: string | undefined;
}) {
  const t = messages;
  const loading = t.loadingRegion;
  return <OverviewLayout messages={messages} about={<WorkAbout work={work} messages={messages} />}
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
    adoption={scope ? <Suspense fallback={<RegionSkeleton id="work-adoption-loading" title={t.adoption}
      label={loading} lines={2} />}>
      <Adoption workRef={workRef} id={id} scope={scope} locale={locale} messages={messages} />
    </Suspense> : null}
    record={<Suspense fallback={<WorkRecord work={work} locale={locale} messages={messages} />}>
      <Record id={id} workRef={workRef} work={work} locale={locale} messages={messages} /></Suspense>}
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

export async function WorkContents({ workRef, id, query, locale, messages }: Common & {
  workRef: string; id: string; query: ContentsQuery | null;
}) {
  const contents = query ? await readContents(id, query) : { ok: false as const, failure: 'invalid' as const };
  return <ContentsRegion contents={contents} workRef={workRef} query={query ?? {}} locale={locale} messages={messages} />;
}
