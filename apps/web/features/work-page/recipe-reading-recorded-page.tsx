import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { NO_PLATFORM_ACCESS, parsePlatformAccess } from '../api/platform-access.ts';
import { signInPath } from '../auth/paths.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { entryLabel, typeEntry } from '../catalogue/types.ts';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import type { FacetList } from '../concept/types.ts';
import { ProvisionalNotice } from '../catalogue-intake/provisional-notice.tsx';
import { copyOf as entityCopy, inSentence } from '../entity-page/messages.ts';
import { entityHref, standaloneHrefFor } from '../entity-page/route.ts';
import type { EntityProjection, EntitySection } from '../entity-page/types.ts';
import { DiscussionView, StatementsView } from '../entity-page/views.tsx';
import type { RecipeExport, RecipeExportApi } from '../recipe-editor/export-api.ts';
import { copyOf as recipeEditorCopy } from '../recipe-editor/messages.ts';
import { recipeEditHref } from '../recipe-editor/route.ts';
import type { RelationshipsApi } from '../relationships/types.ts';
import type { WorkShowcase } from '../api/showcase.ts';
import { messages as showcaseMessages } from '../showcase/messages.ts';
import { workShowcaseHeader } from '../showcase/work-header.tsx';
import { allowedActionsOf, mayEdit } from '../work-levels-edit/allowed.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { ConnectionsPreviewView, EditionsPreviewView, PartsPreviewView, PREVIEW_COUNTS } from '../work-levels/previews.tsx';
import type { Names } from '../work-levels/types.ts';
import { readAnimeReaderState, readLinkedStatements, readResourcePage, readWorkParts, readWorkRealizations } from './anime-hub-recorded-page.ts';
import { AlsoEnjoyedSection } from './also-enjoyed.tsx';
import { AuthorSection } from './author.tsx';
import { booksEditionReads, settle, type BooksRead } from './books-edition-page.read.ts';
import { ClassificationRegion } from './classification.tsx';
import { ProposeCorrectionSlot } from './correction-slot.tsx';
import { publicationSource } from './publication-source.tsx';
import { coverAuthors, WorkCredits } from './credits.tsx';
import { AdoptionRegion } from './adoption.tsx';
import type { WorkPageMessages } from './messages.ts';
import { RatingLine, RatingSummaryRegion } from './ratings.tsx';
import {
  loadRecipeIdentity, recipeReadingReads, type RecipeWorkHost,
} from './recipe-reading-recorded-page.ts';
import { RegionFailure } from './region.tsx';
import { RecipeExperience, RecipeFacts, type RecipePageRead } from './types/recipe.tsx';
import { WorkRecord } from './record.tsx';
import { EVERYONE, iriOf, mainScope, workHref, workRefOf, type WorkAt, type WorkScope } from './route.ts';
import { ScopeBar, type ScopeRealm } from './scope-bar.tsx';
import { shelfWords } from './shelf-words.ts';
import type { AdoptionPage, Loaded, RatingContextPage, RatingRead, RecipeWorkPage, WorkHeader as Header } from './types.ts';
import { WorkKindActions } from './types/actions.tsx';
import { SeriesProgressPanel } from '../tracking/series-progress-panel.tsx';
import { OverviewLayout, WorkFrame, WorkPageCover } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';
import { hubLabels, hubPlan, type HubSection } from './hub.ts';
import { workExperience } from '../entity-page/experience.ts';
import { WikiSectionView, WikiShortcutView } from './wiki.tsx';
import { wikiZoneRead } from './wiki.ts';

// The published recipe page. `WorkFrameView` and `WorkOverview` call these for a
// recipe; a story calls the same functions with the replaying client. The module
// stays free of `next/headers` so the browser bundle can load it.

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

async function readShowcase(host: RecipeWorkHost, work: string): Promise<WorkShowcase | null> {
  const read = await settleOpen(() => browserMainApi(host.publicOrigin, {
    anonymous: true, fetcher: host.publicFetch,
  }).v1.resources.showcase.post({
    profile: 'work-showcase-batch-v1', targets: [work],
  }));
  if (!read.ok || !read.data.complete) return null;
  const item = read.data.items.find(entry => entry.reference === work && entry.status === 'available');
  // Eden's image-role union infers `never`. The header admits the recorded roles.
  return item?.status === 'available' ? item as WorkShowcase : null;
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
export function RecipeRegionView({ recipe, href, actingSubject, text, edit, locale, messages, readPage, exportApi, saveExport }: {
  exportApi?: RecipeExportApi; saveExport?: (value: RecipeExport) => void;
  recipe: Loaded<RecipeWorkPage | null>; href: string; actingSubject: string | null; text: string | null;
  edit?: { href: string; label: string } | null; locale: UiLocale; messages: WorkPageMessages; readPage?: RecipePageRead;
}) {
  if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
  return <RecipeExperience initial={recipe.data} href={href} actingSubject={actingSubject} text={text}
    edit={edit} locale={locale} messages={messages} readPage={readPage} exportApi={exportApi} saveExport={saveExport} />;
}

/** The recipe region, including a later page through the caller's client. */
export async function recipeRegion({ host, id, work, href, locale, messages }: {
  host: RecipeWorkHost; id: string; work: Header; href: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const reads = recipeReadingReads({ main: host.main, actingSubject: host.actingSubject });
  const [recipe, text, authority] = await Promise.all([
    reads.readRecipe(href),
    reads.readText(work.mainVersion, work.selectedLanguage ?? undefined),
    // Signed-in readers read the page again for `work.edit`. It is the same projection.
    host.actingSubject ? reads.readProjection(id) : Promise.resolve(null),
  ]);
  if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
  const allowed = authority?.ok ? allowedActionsOf(authority.data) : [];
  // Only data crosses this server/client boundary. RecipeExperience creates its continuation
  // reader in the browser; a reader closure here cannot be serialized by React Server Components.
  return <RecipeExperience initial={recipe.data} href={href} actingSubject={host.actingSubject}
    recordingFetch={host.recordingFetch}
    edit={mayEdit(allowed) ? { href: recipeEditHref(id), label: recipeEditorCopy(locale).editRecipe } : null}
    text={text.ok ? text.data.body : null}
    locale={locale} messages={messages} />;
}

/** Header, credits, ratings and the reached frame. The overview is `children`. */
export async function recipeWorkFrame({ host, workRef, id, work, locale, messages, children, sources, readerActions, relationships }: {
  host: RecipeWorkHost; workRef: WorkAt; id: string; work: Header; locale: UiLocale; messages: WorkPageMessages;
  children: ReactNode; sources?: ReactNode; readerActions?: ReaderActions; relationships?: RelationshipsApi;
}) {
  const actingSubject = actor(host);
  const reads = recipeReadingReads({ main: host.main, actingSubject: host.actingSubject });
  const [identity, projection, ratings, seed, art] = await Promise.all([
    loadRecipeIdentity(reads, id),
    readResourcePage(host.main, actingSubject, id),
    readRatings(host, id),
    readAnimeReaderState(host.main, actingSubject, id),
    readShowcase(host, work.id),
  ]);
  const stats = await readStats(host, id, ratings.ok ? ratings.data.context?.context : undefined);
  const experience = workExperience(projection.ok ? projection.data : null, work.types);
  const plan = hubPlan(projection.ok ? projection.data : null);
  const statements = projection.ok ? sectionOf(projection.data, 'statements') : undefined;
  const facts = statements ? await readLinkedStatements(host.main, actingSubject, statements.href) : undefined;
  const recipe = experience.typeSection ? await reads.readRecipe(experience.typeSection.href) : null;
  const zone = wikiZoneRead(projection, facts);
  const t = materializeData(messages, { locale });
  // A recipe does not render the cover rail. Native authors stay on the credit read; the cover
  // helper still needs a work-credits page, which this identity types as a byline.
  const authors = identity.kind === 'ready'
    ? coverAuthors(identity.agentCredits, { ok: false, failure: 'missing' }, key => t.openLibraryAuthor({ key })) : [];
  const avatarQuery = host.actingSubject ? `?actingSubject=${encodeURIComponent(host.actingSubject)}` : '';
  const context = ratings.ok ? ratings.data.context : null;
  return <WorkFrame workRef={workRef} work={work} experience={experience} locale={locale} messages={messages}
    signedIn={host.signedIn} actingSubject={seed ? host.actingSubject : null} readerSeed={seed ?? undefined}
    readerActions={readerActions} relationships={relationships}
    ratingTarget={context ? { work: work.id, context: context.context, mainVersion: work.mainVersion, max: context.scale.max } : null}
    signInHref={signInPath(localizedPath(workHref(workRef), locale))} avatarQuery={avatarQuery}
    showcase={workShowcaseHeader(art ?? undefined, showcaseMessages[locale])}
    cover={<WorkPageCover work={work} authors={authors} avatarQuery={avatarQuery} />}
    credits={identity.kind === 'ready'
      ? <WorkCredits agentCredits={identity.agentCredits} credits={identity.credits} source={publicationSource(work)} locale={locale} messages={messages} />
      : <WorkCredits agentCredits={{ ok: false, failure: 'unavailable' }} credits={{ ok: false, failure: 'unavailable' }}
        locale={locale} messages={messages} />}
    ratingLine={<RatingLine ratings={ratings} stats={stats} experience={experience} locale={locale} messages={messages} />}
    domainFacts={recipe?.ok && recipe.data ? <RecipeFacts page={recipe.data} messages={messages} /> : null}
    sources={<>
      {sources}
      {!projection.ok ? <RegionFailure title={messages.fullFacts} failure={projection.failure} messages={messages} /> : null}
      {facts ? <details className="group min-w-0 border-border/70 border-y" data-full-facts>
        <summary className="cursor-pointer rounded-sm py-4 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {messages.fullFacts}</summary>
        <div className="grid gap-5 pb-6">
          <StatementsView page={facts} names={new Map()} cursor={undefined}
            hrefFor={standaloneHrefFor({}, entityHref(id))} locale={locale} t={entityCopy(locale)} messages={messages} />
          <ProposeCorrectionSlot work={id} locale={locale} messages={messages} />
        </div>
      </details> : null}
      <WorkRecord work={work} locale={locale} messages={messages} />
    </>}
    sections={hubLabels(messages, plan)}
    readAction={recipe?.ok && recipe.data && (recipe.data.ingredients.length || recipe.data.instructions?.length)
      ? <WorkKindActions kind={experience.kind} workId={work.id} title={work.title.value} locale={locale}
        messages={messages} words={shelfWords(experience, messages)} /> : null}
    shortcuts={<>
      <ProvisionalNotice verification={work.verification} provenance={work.fieldProvenance} locale={locale} />
      {plan.includes('wiki') ? <WikiShortcutView realm={zone.ok ? zone.data : null} locale={locale} messages={messages} /> : null}
    </>}>
    {children}
  </WorkFrame>;
}

/** The overview under the frame: recipe, parts, progress and the sections the projection binds. */
export async function recipeWorkOverview({ host, workRef, id, work, scope, locale, messages, lead }: {
  host: RecipeWorkHost; workRef: WorkAt; id: string; work: Header; scope: WorkScope | null; locale: UiLocale;
  messages: WorkPageMessages; lead?: readonly HubSection[];
}) {
  const actingSubject = actor(host);
  const reads = recipeReadingReads({ main: host.main, actingSubject: host.actingSubject });
  const [identity, projection] = await Promise.all([
    loadRecipeIdentity(reads, id), readResourcePage(host.main, actingSubject, id),
  ]);
  if (identity.kind !== 'ready' || !projection.ok) {
    return <RegionFailure title={messages.recipeMethod} failure={identity.kind === 'ready' ? 'unavailable' : identity.failure}
      messages={messages} />;
  }
  const experience = workExperience(projection.data, work.types);
  const plan = hubPlan(projection.data);
  const page = projection.data;
  const statementsSection = sectionOf(page, 'statements');
  const discussionSection = sectionOf(page, 'discussion');
  const section = experience.typeSection;
  const [recipe, statements, discussion, parts, wholes, relations, realizations, releases, populations,
    ratings, classifications, facets, adoptions, alsoEnjoyed, authority] = await Promise.all([
    section ? recipeRegion({ host, id, work, href: section.href, locale, messages }) : Promise.resolve(null),
    statementsSection ? readLinkedStatements(host.main, actingSubject, statementsSection.href) : Promise.resolve(null),
    discussionSection ? settleOpen(() => host.main.v1.resources({ resource: id }).discussion.get({
      query: { actingSubject },
    })) : Promise.resolve(null),
    readWorkParts(host.main, actingSubject, id, { limit: PREVIEW_COUNTS.parts + 1 }),
    settleOpen(() => host.main.v1.resources({ resource: id }).wholes.get({
      query: { actingSubject, limit: PREVIEW_COUNTS.wholes },
    })),
    settleOpen(() => host.main.v1.resources({ resource: id }).relations.get({
      query: { actingSubject, limit: 20 },
    })),
    readWorkRealizations(host.main, actingSubject, id),
    booksEditionReads({ main: host.main, ...(actingSubject ? { actingSubject } : {}) }).readReleases(id),
    settleOpen(() => host.main.v1['rating-populations'].get({
      query: { target: iriOf(id), limit: 20, ...(actingSubject ? { actingSubject } : {}) },
    })),
    scope ? readRatings(host, id) : Promise.resolve(null),
    scope && scope.kind !== 'mine' ? settleOpen(() => host.main.v1.works({ id }).classifications.get({
      query: { actingSubject, ...mainScope(scope) },
    })) : Promise.resolve(null),
    scope ? settleOpen(() => host.anonymous.v1.facets.get()) : Promise.resolve(null),
    scope ? readAdoptions(host, id) : Promise.resolve(null),
    settleOpen(() => host.main.v1.works({ id })['also-enjoyed'].get({
      query: { actingSubject, limit: 12 },
    })),
    readPlatform(host),
  ]);
  void authority;
  let ratingRealms: ScopeRealm[] = [];
  if (populations.ok) {
    // A continued population page is not the set of Realms this bar can offer.
    if (populations.data.nextCursor) throw new Error('Rating populations still continue');
    for (const item of populations.data.items) {
      if (!item.global) ratingRealms.push({ id: item.id.slice(-36), name: item.name, ratingCount: item.ratingCount,
        readerCommunity: item.readerCommunity });
    }
  }
  const names: Names = new Map();
  const avatarQuery = host.actingSubject ? `?actingSubject=${encodeURIComponent(host.actingSubject)}` : '';
  const scopeView = { workRef, scope: scope ?? EVERYONE, realms: ratingRealms };
  const facet = classificationFacet(facets?.ok ? facets.data as FacetList : null);
  const entry = page.registry ?? typeEntry(work.types);
  const subject = entry ? inSentence(entryLabel(entry, locale), locale) : work.title.value;
  const hrefFor = standaloneHrefFor({}, entityHref(id));
  const entity = entityCopy(locale);
  const zone = wikiZoneRead(projection, statements ?? undefined);
  const levels = levelsCopy(locale);
  return <OverviewLayout messages={messages} plan={plan} lead={lead}
    type={<>
      <WorkAbout work={work} locale={locale} messages={messages} />
      {recipe}
    </>}
    about={null}
    availability={<EditionsPreviewView realizations={realizations} releases={releases} workRef={workRefOf(workRef)}
      locale={locale} pageMessages={messages} t={levels} />}
    parts={<>
      {host.actingSubject ? <SeriesProgressPanel work={iriOf(id)} locale={locale} preferenceForm={false} /> : null}
      <PartsPreviewView parts={parts} wholes={wholes} names={names} workRef={workRefOf(workRef)} pageMessages={messages}
        t={levels} />
      {relations ? <ConnectionsPreviewView relations={relations} workRef={workRefOf(workRef)} locale={locale}
        pageMessages={messages} t={levels} /> : null}
    </>}
    wiki={<WikiSectionView wiki={{ zone, characters: null }} locale={locale} messages={messages} />}
    scopeBar={<ScopeBar workRef={workRef} scope={scope} realms={ratingRealms} locale={locale} messages={messages}
      target={iriOf(id)} actingSubject={actingSubject} />}
    ratings={scope && ratings ? <RatingSummaryRegion ratings={ratings} view={scopeView} locale={locale} messages={messages}
      scopeBar={<ScopeBar workRef={workRef} scope={scope} realms={ratingRealms} locale={locale} messages={messages}
        target={iriOf(id)} actingSubject={actingSubject} />} /> : null}
    classification={scope && classifications ? <ClassificationRegion classifications={classifications} view={scopeView}
      facet={facet ? { id: facet.id, label: facetLabel(facet, locale) } : null} locale={locale} messages={messages} /> : null}
    reviews={null}
    discussion={discussion ? <DiscussionView page={discussion} realms={new Map()} cursor={undefined} resource={work.id}
      subject={subject} signedIn={host.signedIn} hrefFor={hrefFor} locale={locale} t={entity} messages={messages} /> : null}
    adoption={scope && adoptions ? <AdoptionRegion adoptions={adoptions} view={scopeView} locale={locale}
      messages={messages} /> : null}
    record={null}
    alsoEnjoyed={<AlsoEnjoyedSection alsoEnjoyed={alsoEnjoyed} book={false} realms={[]} avatarQuery={avatarQuery}
      locale={locale} messages={messages} />}
    author={identity.author ? <AuthorSection author={{ kind: 'agent', name: identity.author.name, handle: identity.author.handle,
      agent: identity.author.agent, works: identity.author.works }} work={id} avatarQuery={avatarQuery} locale={locale}
      messages={messages} /> : null} />;
}


