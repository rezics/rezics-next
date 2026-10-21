import { materializeData } from 'native-i18n';
import { buttonVariants } from '@rezics/ui/button';
import { PencilIcon } from 'lucide-react';
import { cache, Suspense, type ComponentProps, type ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { NO_PLATFORM_ACCESS, parsePlatformAccess } from '../api/platform-access.ts';
import { signInPath } from '../auth/paths.ts';
import Link from '../shell/localized-link.tsx';
import { ReaderActionsProvider, ShelfButton, type ReaderActions } from '../catalogue/reader-actions.tsx';
import { readerEntry } from '../catalogue/reader-store.ts';
import { entryLabel, typeEntry } from '../catalogue/types.ts';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import type { FacetList } from '../concept/types.ts';
import { ProvisionalNotice } from '../catalogue-intake/provisional-notice.tsx';
import { copyOf as entityCopy, inSentence } from '../entity-page/messages.ts';
import { entityHref, standaloneHrefFor } from '../entity-page/route.ts';
import type { EntityProjection, EntitySection } from '../entity-page/types.ts';
import { DiscussionView } from '../entity-page/views.tsx';
import { WorkFactsView, WorkSources, workFactsSelection } from './work-sources.tsx';
import type { DisplayObligations } from '../rights-mark/rights-mark.tsx';
import type { RecipeExport, RecipeExportApi } from '../recipe-editor/export-api.ts';
import { copyOf as recipeEditorCopy } from '../recipe-editor/messages.ts';
import { recipeMethodReady } from '../recipe-editor/instructions.ts';
import { recipeEditHref } from '../recipe-editor/route.ts';
import type { RelationshipsApi } from '../relationships/types.ts';
import type { WorkShowcase } from '../api/showcase.ts';
import { messages as showcaseMessages } from '../showcase/messages.ts';
import { workShowcaseHeader } from '../showcase/work-header.tsx';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { ConnectionsPreviewView, EditionsPreviewView, PartsPreviewView, PREVIEW_COUNTS } from '../work-levels/previews.tsx';
import type { Names } from '../work-levels/types.ts';
import { readLinkedStatements, readResourcePage, readWorkParts, readWorkRealizations } from './anime-hub-recorded-page.ts';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import { AuthorSection } from './author.tsx';
import { booksEditionReads, settle, type BooksRead } from './books-edition-page.read.ts';
import { ClassificationRegion } from './classification.tsx';
import { ProposeCorrectionSlot } from './correction-slot.tsx';
import { publicationSource } from './publication-source.tsx';
import { coverAuthors, WorkCredits, WorkCreditsSkeleton } from './credits.tsx';
import { AdoptionRegion } from './adoption.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import {
  loadRecipeIdentity, recipeReadingReads, type RecipeWorkHost,
} from './recipe-reading-recorded-page.ts';
import { RegionFailure, RegionSkeleton } from './region.tsx';
import { RecipeExperience, RecipeFacts, RecipeReadFailure, type RecipePageRead } from './types/recipe.tsx';
import { WorkRecord } from './record.tsx';
import { EVERYONE, iriOf, mainScope, workHref, type WorkAt, type WorkScope } from './route.ts';
import { ScopeBar, type ScopeRealm } from './scope-bar.tsx';
import { shelfWords } from './shelf-words.ts';
import type { AdoptionPage, Loaded, RatingContextPage, RatingRead, ReadFailure, RecipeWorkPage, WorkHeader as Header } from './types.ts';
import { WorkKindActions } from './types/actions.tsx';
import { SeriesProgressPanel } from '../tracking/series-progress-panel.tsx';
import { OverviewLayout, WorkFrame, WorkIdentity, WorkPageCover } from './work-frame.tsx';
import { WorkRating } from './work-nav.tsx';
import { WorkAbout } from './work-header.tsx';
import { hubLabels, hubPlan, type HubSection } from './hub.ts';
import { workExperience } from '../entity-page/experience.ts';
import { WikiSectionView, WikiShortcutView } from './wiki.tsx';
import { wikiZoneRead } from './wiki.ts';

// The published recipe page. `WorkFrameView` and `WorkOverview` call these for a
// recipe; a story calls the same functions with the replaying client. The module
// stays free of `next/headers` so the browser bundle can load it.

// React's request cache gives the frame and its streamed body the exact same owner answers.
// Nothing is retained across requests or acting people; continuation/scaling remain fresh reads.
const initialRecipe = cache((main: RecipeWorkHost['main'], actingSubject: string | null, href: string) =>
  recipeReadingReads({ main, actingSubject }).readRecipe(href));
const recipeIdentity = cache((main: RecipeWorkHost['main'], actingSubject: string | null, id: string) =>
  loadRecipeIdentity(recipeReadingReads({ main, actingSubject }), id));
const recipeProjection = cache((main: RecipeWorkHost['main'], actingSubject: string | null, id: string) =>
  readResourcePage(main, actingSubject ?? undefined, id));

type Answer<T> = { data: T | null; error: { status: number; value?: unknown } | null };

function rethrowRecorded(error: unknown): void {
  if (error instanceof Error && error.message.includes('recorded request')) throw error;
}

/** `settle` hides transport failures. A replay miss must stay visible to the story. */
async function settleOpen<T>(call: () => Promise<Answer<T>>): Promise<BooksRead<T>> {
  try {
    return await settle(call);
  } catch (error) {
    rethrowRecorded(error);
    return { ok: false, failure: 'unavailable' };
  }
}

function sectionOf(page: EntityProjection, id: EntitySection['id']): EntitySection | undefined {
  return page.sections.find(section => section.id === id);
}

function actor(host: RecipeWorkHost): string | undefined {
  return host.actingSubject ?? undefined;
}

async function readPlatform(host: RecipeWorkHost) {
  try {
    const result = await host.main.v1.me['platform-access'].get();
    return (result.data ? parsePlatformAccess(result.data) : null) ?? NO_PLATFORM_ACCESS;
  } catch (error) {
    rethrowRecorded(error);
    return NO_PLATFORM_ACCESS;
  }
}

async function readShowcase(host: RecipeWorkHost, work: string): Promise<Loaded<WorkShowcase | null>> {
  const read = await settleOpen(() => browserMainApi(host.publicOrigin, {
    anonymous: true, fetcher: host.publicFetch,
  }).v1.resources.showcase.post({
    profile: 'work-showcase-batch-v1', targets: [work],
  }));
  if (!read.ok) return read;
  if (!read.data.complete) return { ok: false, failure: 'unavailable' };
  const item = read.data.items.find(entry => entry.reference === work && entry.status === 'available');
  // Eden's image-role union infers `never`. The header admits the recorded roles.
  return { ok: true, data: item?.status === 'available' ? item as WorkShowcase : null };
}

async function readRatings(host: RecipeWorkHost, id: string): Promise<Loaded<RatingRead>> {
  const actingSubject = actor(host);
  const scope = mainScope(EVERYONE);
  const contexts = await settleOpen(() => host.main.v1.resources({ resource: id })['rating-contexts'].get({
    query: { actingSubject, ...scope },
  }));
  if (!contexts.ok) return contexts;
  const page = contexts.data as RatingContextPage;
  // The header shows one question only when this page is the whole list.
  if (page.nextCursor) return { ok: false, failure: 'unavailable' };
  const items = page.items;
  const context = items[0] ?? null;
  const summary = await settleOpen(() => host.main.v1.resources({ resource: id }).ratings.get({
    query: { actingSubject, ...scope, context: context?.context },
  }));
  return summary.ok ? { ok: true, data: { contexts: items, context, summary: summary.data } } : summary;
}

async function readStats(host: RecipeWorkHost, id: string, context: string | undefined) {
  return settleOpen(() => host.main.v1.works({ id })['reader-stats'].get({
    query: { actingSubject: actor(host), context },
  }));
}

function readAdoptions(host: RecipeWorkHost, id: string): Promise<BooksRead<AdoptionPage>> {
  return settleOpen(async () => {
    const result = await host.main.v1.query.post({
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-adoptions', revision: 1,
      parameters: { roots: [iriOf(id)] }, presentation: { actingSubject: actor(host) },
    });
    return {
      error: result.error,
      data: result.data?.result.profile === 'template-result-v1'
        && result.data.result.query === 'https://rezics.com/query/work-adoptions' ? result.data.result : null,
    };
  });
}

/** The production recipe region. The editor preview and the Work page render this same content. */
export function RecipeRegionView({ resource, recipe, href, actingSubject, text, edit, locale, messages, readPage, exportApi, saveExport }: {
  exportApi?: RecipeExportApi; saveExport?: (value: RecipeExport) => void;
  resource: string; recipe: Loaded<RecipeWorkPage | null>; href: string; actingSubject: string | null; text: string | null;
  edit?: { href: string; label: string } | null; locale: UiLocale; messages: WorkPageMessages; readPage?: RecipePageRead;
}) {
  if (!recipe.ok) return <RecipeReadFailure failure={recipe.failure} messages={messages} />;
  return <RecipeExperience resource={resource} initial={recipe.data} href={href} actingSubject={actingSubject} text={text}
    edit={edit} locale={locale} messages={messages} readPage={readPage} exportApi={exportApi} saveExport={saveExport} />;
}

/** The recipe region, including a later page through the caller's client. */
export async function recipeRegion({ host, id, work, href, locale, messages }: {
  host: RecipeWorkHost; id: string; work: Header; href: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const reads = recipeReadingReads({ main: host.main, actingSubject: host.actingSubject });
  const recipe = initialRecipe(host.main, host.actingSubject, href);
  const notes = reads.readText(work.mainVersion, work.selectedLanguage ?? undefined).then(text => {
    if (!text.ok) return text.failure === 'missing' ? null
      : <RegionFailure title={messages.recipeNotes} failure={text.failure} messages={messages} />;
    return text.data.body ? <section className="grid max-w-[70ch] gap-2">
      <h3 className="font-semibold">{messages.recipeNotes}</h3>
      <p lang={text.data.language} className="whitespace-pre-wrap leading-7">{text.data.body}</p>
    </section> : null;
  });
  // Edit authority and notes do not establish the published method. They keep
  // their own reads without holding a recovered method behind their answers.
  const edit = host.actingSubject ? reads.readProjection(id).then(authority =>
    authority.ok && mayEdit(allowedActionsOf(authority.data))
      ? <Link href={recipeEditHref(id)} className={buttonVariants({ variant: 'outline' })}>
        <PencilIcon aria-hidden="true" />{recipeEditorCopy(locale).editRecipe}</Link> : null) : null;
  const answer = await recipe;
  // Only data crosses this server/client boundary. RecipeExperience creates its continuation
  // reader in the browser; a reader closure here cannot be serialized by React Server Components.
  return <RecipeMethod initial={answer.ok ? answer.data : null} failure={answer.ok ? undefined : answer.failure}
    resource={work.id} href={href} actingSubject={host.actingSubject}
    recordingFetch={host.recordingFetch}
    readPage={host.recipeReadPage?.(href)} text={null} locale={locale} messages={messages}
    notes={notes} editLink={edit} />;
}

/** The method remains mounted when its slower notes or edit link arrive. */
function RecipeMethod({ notes, editLink, failure, ...props }: ComponentProps<typeof RecipeExperience> & {
  notes: ReactNode; editLink: ReactNode; failure?: ReadFailure;
}) {
  return <div className="grid min-w-0 gap-4">
    {failure ? <RecipeReadFailure failure={failure} messages={props.messages} />
      : <RecipeExperience {...props} />}
    <Suspense fallback={null}>{editLink}</Suspense>
    <Suspense fallback={null}>{notes}</Suspense>
  </div>;
}

/** Header, credits, ratings and the reached frame. The overview is `children`. */
export async function recipeWorkFrame({ host, workRef, id, work, locale, messages, children, sources, factObligations, readerActions, relationships }: {
  host: RecipeWorkHost; workRef: WorkAt; id: string; work: Header; locale: UiLocale; messages: WorkPageMessages;
  children: ReactNode; sources?: ReactNode; readerActions?: ReaderActions; relationships?: RelationshipsApi;
  factObligations?: readonly DisplayObligations[];
}) {
  const actingSubject = actor(host);
  const reads = recipeReadingReads({ main: host.main, actingSubject: host.actingSubject });
  const ratingRead = readRatings(host, id);
  const readerState = actingSubject ? settleOpen(() => host.main.v1.works({ id })['reader-state'].get({ query: { actingSubject } }))
    : Promise.resolve(null);
  const showcase = readShowcase(host, work.id);
  const credits = Promise.all([
    reads.readAgentCredits(id),
    publicationSource(work) ? reads.readPublicCredits(id) : reads.readWorkCredits(id),
  ]);
  const projection = await recipeProjection(host.main, host.actingSubject, id);
  const experience = workExperience(projection.ok ? projection.data : null, work.types);
  const plan = hubPlan(projection.ok ? projection.data : null);
  // The already-selected Work and its own projection bind this link. Start it
  // before the frame's presentation reads; no credit or author read binds it.
  const recipe = experience.typeSection ? initialRecipe(host.main, host.actingSubject, experience.typeSection.href) : Promise.resolve(null);
  const statements = projection.ok ? sectionOf(projection.data, 'statements') : undefined;
  const selection = workFactsSelection(workRef, host.pageUrl);
  const facts = statements ? selection.invalid ? Promise.resolve({ ok: false as const, failure: 'invalid' as const })
    : readLinkedStatements(host.main, actingSubject, statements.href, { cursor: selection.cursor }) : Promise.resolve(undefined);
  const t = materializeData(messages, { locale });
  // A recipe does not render the cover rail. Native authors stay on the credit read; the cover
  // helper still needs a work-credits page, which this identity types as a byline.
  const avatarQuery = host.actingSubject ? `?actingSubject=${encodeURIComponent(host.actingSubject)}` : '';
  const waitingForMethod = <WorkKindActions kind={experience.kind} workId={work.id} workRef={workRef}
    title={work.title.value} locale={locale} messages={messages} words={shelfWords(experience, messages)}
    canCook={false} recipeHref={experience.typeSection?.href} />;
  const signInHref = signInPath(localizedPath(workHref(workRef), locale));
  const shelf = <ShelfButton work={work.id} title={work.title.value} locale={locale} size="sm" variant="outline"
    words={shelfWords(experience, messages)} className="min-h-11" />;
  const rating = <WorkRating work={work.id} locale={locale} label={messages.ratings} />;
  const actions = <Suspense fallback={<SupplementLoading label={messages.savedStatus} messages={messages} />}>
    {readerState.then(state => state && !state.ok
      ? <RegionFailure title={messages.savedStatus} failure={state.failure} messages={messages} />
      : <ReaderActionsProvider signedIn={host.signedIn} actingSubject={host.actingSubject} signInHref={signInHref}
        seed={state?.ok ? { [state.data.work]: readerEntry(state.data) } : undefined} actions={readerActions}>
        {shelf}
      </ReaderActionsProvider>)}
  </Suspense>;
  const ratingAction = <Suspense fallback={<SupplementLoading label={messages.ratings} messages={messages} />}>
    {Promise.all([readerState, host.actingSubject ? ratingRead : Promise.resolve(null)]).then(([state, ratings]) => {
      if (ratings && !ratings.ok) return <RegionFailure title={messages.ratings} failure={ratings.failure} messages={messages} />;
      if (state && !state.ok) return null; // The shelf already names this private-state failure.
      const context = ratings?.ok ? ratings.data.context : null;
      return <ReaderActionsProvider signedIn={host.signedIn} actingSubject={host.actingSubject} signInHref={signInHref}
        seed={state?.ok ? { [state.data.work]: readerEntry(state.data) } : undefined} actions={readerActions}
        ratingTarget={context ? { work: work.id, context: context.context, mainVersion: work.mainVersion, max: context.scale.max } : null}>
        {rating}
      </ReaderActionsProvider>;
    })}
  </Suspense>;
  const cover = <Suspense fallback={<WorkPageCover work={work} avatarQuery={avatarQuery} />}>
      {credits.then(([agentCredits]) => <WorkPageCover work={work} avatarQuery={avatarQuery}
        authors={coverAuthors(agentCredits, { ok: false, failure: 'missing' }, key => t.openLibraryAuthor({ key }))} />)}
    </Suspense>;
  const creditLine = <Suspense fallback={<WorkCreditsSkeleton label={messages.loadingRegion} />}>
      {credits.then(([agentCredits, byline]) => <WorkCredits agentCredits={agentCredits} credits={byline}
        source={publicationSource(work)} locale={locale} messages={messages} />)}
    </Suspense>;
  const ratingLine = <Suspense fallback={<SupplementLoading label={messages.ratings} messages={messages} />}>{ratingRead.then(async ratings => <RatingLine ratings={ratings}
      stats={await readStats(host, id, ratings.ok ? ratings.data.context?.context : undefined)} experience={experience}
      locale={locale} messages={messages} />)}</Suspense>;
  const domainFacts = <Suspense fallback={null}>{recipe.then(answer => answer?.ok && answer.data
      ? <RecipeFacts page={answer.data} messages={messages} /> : null)}</Suspense>;
  const shortcuts = <>
    <ProvisionalNotice verification={work.verification} provenance={work.fieldProvenance} locale={locale} />
    {plan.includes('wiki') ? <Suspense fallback={<SupplementLoading label={messages.wikiShortcut} messages={messages} />}>
      {facts.then(page => {
        const zone = wikiZoneRead(projection, page);
        return <WikiShortcutView realm={zone.ok ? zone.data : null} locale={locale} messages={messages} />;
      })}
    </Suspense> : null}
  </>;
  const identity = { workRef, work, credits: creditLine, domainFacts, ratingLine, cover, shortcuts, locale, messages };
  return <WorkFrame workRef={workRef} work={work} experience={experience} locale={locale} messages={messages}
    signedIn={host.signedIn} actingSubject={host.actingSubject} relationships={relationships}
    readerActions={{ kind: 'unavailable' }} signInHref={signInHref} avatarQuery={avatarQuery}
    shelfAction={actions} ratingAction={ratingAction} credits={creditLine}
    identity={<>
      <Suspense fallback={<><WorkIdentity {...identity} /><SupplementLoading label={messages.artwork} messages={messages} /></>}>
        {showcase.then(art => <><WorkIdentity {...identity}
          showcase={workShowcaseHeader(art.ok ? art.data ?? undefined : undefined, showcaseMessages[locale])} />
          {!art.ok ? <RegionFailure title={messages.artwork} failure={art.failure} messages={messages} /> : null}</>)}
      </Suspense>
    </>}
    evidence={<Suspense fallback={<SupplementLoading label={messages.sourcesAndEvidence} messages={messages} />}>
      {facts.then(page => <WorkSources work={work} locale={locale} messages={messages} avatarQuery={avatarQuery}
        statements={page} factObligations={factObligations}>
      {sources}
      {!projection.ok ? <RegionFailure title={messages.fullFacts} failure={projection.failure} messages={messages} /> : null}
      {page ? <details className="group min-w-0 border-border/70 border-y" data-full-facts>
        <summary className="cursor-pointer rounded-sm py-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {messages.fullFacts}</summary>
        <div className="grid gap-5 pb-6">
          <WorkFactsView page={page} names={new Map()}
            hrefFor={selection.hrefFor} cursor={selection.cursor} locale={locale} t={entityCopy(locale)} messages={messages} />
          <ProposeCorrectionSlot work={id} locale={locale} messages={messages} />
        </div>
      </details> : null}
      <WorkRecord work={work} locale={locale} messages={messages} />
      </WorkSources>)}
    </Suspense>}
    sections={hubLabels(messages, plan)}
    readAction={<Suspense fallback={waitingForMethod}>{recipe.then(answer =>
      <WorkKindActions kind={experience.kind} workId={work.id} workRef={workRef} title={work.title.value} locale={locale}
        messages={messages} words={shelfWords(experience, messages)} canCook={Boolean(answer?.ok && recipeMethodReady(answer.data))}
        recipeHref={experience.typeSection?.href} />)}</Suspense>}
    >
    {children}
  </WorkFrame>;
}

function SupplementLoading({ label, messages }: { label: string; messages: WorkPageMessages }) {
  return <p role="status" aria-busy="true" aria-label={label} className="text-muted-foreground text-sm">
    {label} · {messages.loadingRegion}
  </p>;
}

/** The overview's method and sibling sections settle at their own boundaries. */
export async function recipeWorkOverview({ host, workRef, id, work, scope, locale, messages, lead }: {
  host: RecipeWorkHost; workRef: WorkAt; id: string; work: Header; scope: WorkScope | null; locale: UiLocale;
  messages: WorkPageMessages; lead?: readonly HubSection[];
}) {
  const actingSubject = actor(host);
  const projection = await recipeProjection(host.main, host.actingSubject, id);
  if (!projection.ok) return <RecipeReadFailure failure={projection.failure} messages={messages} />;
  const experience = workExperience(projection.data, work.types);
  const plan = hubPlan(projection.data);
  const section = experience.typeSection;
  const recipe = section ? recipeRegion({ host, id, work, href: section.href, locale, messages })
    : Promise.resolve(<RecipeReadFailure failure="unavailable" messages={messages} />);
  const statementsSection = sectionOf(projection.data, 'statements');
  const discussionSection = sectionOf(projection.data, 'discussion');
  const statements = statementsSection ? readLinkedStatements(host.main, actingSubject, statementsSection.href) : Promise.resolve(null);
  const discussion = discussionSection ? settleOpen(() => host.main.v1.resources({ resource: id }).discussion.get({
    query: { actingSubject },
  })) : Promise.resolve(null);
  const availability = Promise.all([
    readWorkRealizations(host.main, actingSubject, id),
    booksEditionReads({ main: host.main, ...(actingSubject ? { actingSubject } : {}) }).readReleases(id),
  ]);
  const parts = Promise.all([
    readWorkParts(host.main, actingSubject, id, { limit: PREVIEW_COUNTS.parts + 1 }),
    settleOpen(() => host.main.v1.resources({ resource: id }).wholes.get({
      query: { actingSubject, limit: PREVIEW_COUNTS.wholes },
    })),
    settleOpen(() => host.main.v1.resources({ resource: id }).relations.get({
      query: { actingSubject, limit: 20 },
    })),
  ]);
  const realms = Promise.all([
    settleOpen(() => host.main.v1['rating-populations'].get({
      query: { target: iriOf(id), limit: 20, ...(actingSubject ? { actingSubject } : {}) },
    })), readPlatform(host),
  ]).then(([populations]) => {
    const ratingRealms: ScopeRealm[] = [];
    if (populations.ok) {
      // A continued population page is not the set of Realms this bar can offer.
      if (populations.data.nextCursor) throw new Error('Rating populations still continue');
      for (const item of populations.data.items) {
        if (!item.global) ratingRealms.push({ id: item.id.slice(-36), name: item.name, ratingCount: item.ratingCount,
          readerCommunity: item.readerCommunity });
      }
    }
    return ratingRealms;
  });
  const scopeView = realms.then(ratingRealms => ({ workRef, scope: scope ?? EVERYONE, realms: ratingRealms }));
  const ratings = scope ? readRatings(host, id) : Promise.resolve(null);
  const classifications = scope && scope.kind !== 'mine' ? settleOpen(() => host.main.v1.works({ id }).classifications.get({
    query: { actingSubject, ...mainScope(scope) },
  })) : Promise.resolve(null);
  const facets = scope ? settleOpen(() => host.anonymous.v1.facets.get()) : Promise.resolve(null);
  const adoptions = scope ? readAdoptions(host, id) : Promise.resolve(null);
  const alsoEnjoyed = settleOpen(() => host.main.v1.works({ id })['also-enjoyed'].get({
    query: { actingSubject, limit: 12 },
  }));
  const identity = recipeIdentity(host.main, host.actingSubject, id);
  const names: Names = new Map();
  const avatarQuery = host.actingSubject ? `?actingSubject=${encodeURIComponent(host.actingSubject)}` : '';
  const entry = projection.data.registry ?? typeEntry(work.types);
  const subject = entry ? inSentence(entryLabel(entry, locale), locale) : work.title.value;
  const hrefFor = standaloneHrefFor({}, entityHref(id));
  const entity = entityCopy(locale);
  const levels = levelsCopy(locale);
  const scopeBar = <Suspense fallback={null}>{realms.then(ratingRealms =>
    <ScopeBar workRef={workRef} scope={scope} realms={ratingRealms} locale={locale} messages={messages}
      target={iriOf(id)} actingSubject={actingSubject} />)}</Suspense>;
  return <OverviewLayout messages={messages} plan={plan} lead={lead}
    type={<>
      <WorkAbout work={work} locale={locale} messages={messages} />
      <Suspense fallback={<RegionSkeleton id="work-recipe-loading" title={messages.recipeMethod}
        label={messages.loadingRegion} lines={5} />}>{recipe}</Suspense>
    </>}
    about={null}
    availability={<Suspense fallback={<RegionSkeleton id="work-availability-loading" title={messages.sectionAvailability}
      label={messages.loadingRegion} />}>
      {availability.then(([realizations, releases]) => <EditionsPreviewView realizations={realizations} releases={releases}
        workRef={workRef} locale={locale} pageMessages={messages} t={levels} />)}
    </Suspense>}
    parts={<Suspense fallback={<RegionSkeleton id="work-parts-loading" title={messages.sectionParts}
      label={messages.loadingRegion} />}>
      {parts.then(([partPage, wholes, relations]) => <>
        {host.actingSubject ? <SeriesProgressPanel work={iriOf(id)} locale={locale} preferenceForm={false} /> : null}
        <PartsPreviewView parts={partPage} wholes={wholes} names={names} workRef={workRef}
          pageMessages={messages} t={levels} />
        <ConnectionsPreviewView relations={relations} workRef={workRef} locale={locale} pageMessages={messages} t={levels} />
      </>)}
    </Suspense>}
    wiki={<Suspense fallback={<RegionSkeleton id="work-wiki-loading" title={messages.sectionWiki}
      label={messages.loadingRegion} lines={2} />}>
      {statements.then(page => <WikiSectionView wiki={{ zone: wikiZoneRead(projection, page ?? undefined), characters: null }}
        locale={locale} messages={messages} />)}
    </Suspense>}
    scopeBar={scopeBar}
    ratings={scope ? <Suspense fallback={<RegionSkeleton id="work-ratings-loading" title={messages.ratings}
      label={messages.loadingRegion} lines={4} />}>
      {Promise.all([ratings, scopeView]).then(([page, view]) => page ? <RatingSummaryRegion ratings={page} view={view}
        locale={locale} messages={messages} scopeBar={scopeBar} /> : null)}
    </Suspense> : null}
    classification={scope ? <Suspense fallback={null}>
      {Promise.all([classifications, facets, scopeView]).then(([page, facetPage, view]) => {
        const facet = classificationFacet(facetPage?.ok ? facetPage.data as FacetList : null);
        return page ? <ClassificationRegion classifications={page} view={view}
          facet={facet ? { id: facet.id, label: facetLabel(facet, locale) } : null} locale={locale} messages={messages} /> : null;
      })}
    </Suspense> : null}
    reviews={null}
    discussion={<Suspense fallback={<RegionSkeleton id="work-discussion-loading" title={messages.sectionDiscussion}
      label={messages.loadingRegion} lines={4} />}>
      {discussion.then(page => page ? <DiscussionView page={page} realms={new Map()} cursor={undefined} resource={work.id}
        subject={subject} signedIn={host.signedIn} hrefFor={hrefFor} locale={locale} t={entity} messages={messages} /> : null)}
    </Suspense>}
    adoption={scope ? <Suspense fallback={null}>{Promise.all([adoptions, scopeView]).then(([page, view]) =>
      page ? <AdoptionRegion adoptions={page} view={view} locale={locale} messages={messages} /> : null)}
    </Suspense> : null}
    record={null}
    alsoEnjoyed={<Suspense fallback={null}>{alsoEnjoyed.then(page => <AlsoEnjoyedSection alsoEnjoyed={page} book={false}
      realms={[]} avatarQuery={avatarQuery} locale={locale} messages={messages} />)}</Suspense>}
    author={<Suspense fallback={null}>{identity.then(value => value.kind === 'ready' && value.author
      ? <AuthorSection author={{ kind: 'agent', name: value.author.name, handle: value.author.handle,
        agent: value.author.agent, works: value.author.works }} work={id} avatarQuery={avatarQuery} locale={locale}
        messages={messages} /> : null)}</Suspense>} />;
}
