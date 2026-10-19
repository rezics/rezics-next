import { buttonVariants } from '@rezics/ui/button';
import { ChevronDownIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { cache, Suspense } from 'react';
import { headers } from 'next/headers';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { readEntityProjection, readStatements, sectionOf } from '../entity-page/read.ts';
import { readPredicateLabels } from '../entity-page/predicate-labels.ts';
import { namesOf } from '../work-levels/read.ts';
import { workExperience } from '../entity-page/experience.ts';
import { entityHref, standaloneHrefFor } from '../entity-page/route.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import { DiscussionSection } from '../entity-page/sections.tsx';
import { withoutOwnName } from '../entity-page/statement-groups.ts';
import { WorkFactsView, workFactsSelection } from './work-sources.tsx';
import Link from '../shell/localized-link.tsx';
import { SeriesProgressPanel } from '../tracking/series-progress-panel.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { readParts, readRealizations, readReleases as readReleasePage } from '../work-levels/read.ts';

import { EditionsPreviewView } from '../work-levels/previews.tsx';
import { ConnectionsPreview, PartsPreview } from '../work-levels/previews-server.tsx';
import { editionsHref } from '../work-levels/route.ts';
import type { WorkPageClient } from './work-views.tsx';
import type { WorkPageMessages } from './messages.ts';
import { IdentityStatus, nextAction, NextActionView } from './primary-action.tsx';
import { ProposeCorrectionSlot } from './correction-slot.tsx';
import { readEditionPreference, readEditionRelease, readEditionRealization, readProgressSummary, readReleases, readStart, readingAgent, readWorkHeader } from './read.ts';
import { Region, RegionFailure } from './region.tsx';
import { iriOf, workHref, type WorkAt, workRefOf } from './route.ts';
import type { WorkHeader as Header } from './types.ts';
import { YourEdition } from './your-edition.tsx';
import { BooksEditionPage } from './books-edition-page.tsx';
import { readBooksEditionStatus } from './books-edition-page.read.ts';

// The server halves of the hub sections compose other owners' previews, controls and widgets.
// Each reads on its own under the caller's Suspense, so one failing leaves the rest of the page.

interface Common { locale: UiLocale; messages: WorkPageMessages; client?: WorkPageClient }

/** Progress is counted in a language: the reader's chosen one, else the one the interface is in (as the series panel does). */
const progressLanguage = (preference: Awaited<ReturnType<typeof readEditionPreference>>, locale: UiLocale) =>
  preference.ok && preference.data ? preference.data.language : locale;

/**
 * The page's one primary action and the reader's status under it. Main decides: hosted text first, then the
 * next part its progress summary names, then choosing an edition; this maps the answers to a button.
 */
export async function PrimaryAction({ workRef, id, work, locale, messages, client }: Common & { workRef: WorkAt; id: string;
  work: Header }) {
  const [start, preference, releases] = await Promise.all([readStart(id, work.id, locale, work.selectedLanguage, client),
    readEditionPreference(id, client), readReleases(id, client)]);
  const progress = await readProgressSummary(id, progressLanguage(preference, locale), client);
  const inventory = releases.ok ? { entries: releases.data.items, nextCursor: releases.data.nextCursor } : null;
  const action = nextAction({ start, progress, preference, releases: inventory?.entries.length ?? 0 });
  if (start?.kind === 'unavailable') return <div className="grid gap-3">
    <RegionFailure title={messages.contents} failure={start.failure} messages={messages} />
    {action ? <NextActionView action={action} workRef={workRef} locale={locale} messages={messages} /> : null}
  </div>;
  return action ? <NextActionView action={action} workRef={workRef} locale={locale} messages={messages} /> : null;
}

/**
 * The edition the reader chose and their progress, named in Main's words, under the primary action. A chosen
 * release is named by its own title; a chosen realization, which has none, by its language.
 */
export async function Status({ id, locale, messages, client }: Common & { id: string }) {
  const status = await readBooksEditionStatus({
    readEditionPreference: key => readEditionPreference(key, client),
    readProgressSummary: (key, language) => readProgressSummary(key, language, client),
    readEditionRelease: (key, release) => readEditionRelease(key, release, client),
    readEditionRealization: (key, realization, revision) => readEditionRealization(key, realization, revision, client),
  }, id, locale);
  return <IdentityStatus {...status} locale={locale} messages={messages} />;
}

/** Facts and their source records share the same read on every Work view. */
export const readWorkFacts = cache(async (id: string, locale: UiLocale, client?: WorkPageClient) => {
  const selection = workFactsSelection(id, client ? client.pageUrl : (await headers()).get('x-rezics-page-url'));
  const projection = await readEntityProjection(id, undefined, client);
  const section = projection.ok ? sectionOf(projection.data, 'statements') : undefined;
  const page = section ? selection.invalid ? { ok: false as const, failure: 'invalid' as const }
    : await readStatements(section, selection.cursor, undefined, undefined, client) : undefined;
  const [labels, names] = page?.ok ? await Promise.all([
    readPredicateLabels(page.data, locale, client),
    namesOf(page.data.groups.flatMap(group => withoutOwnName(group).flatMap(item => [
      ...item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : [],
      ...item.kind === 'component-property' && item.value.kind === 'resource' && typeof item.value.ref === 'string' ? [item.value.ref] : [],
      ...item.qualifiers.applicability,
    ])), undefined, client),
  ]) : [new Map(), new Map()];
  return { projection, page, labels, names, selection };
});

/** Accepted facts on expansion; source records and attribution belong to the enclosing page-end section. */
export async function AboutFacts({ id, locale, messages, client }: Common & { id: string }) {
  const { projection, page, labels, names, selection } = await readWorkFacts(id, locale, client);
  if (!projection.ok) return <RegionFailure title={messages.fullFacts} failure={projection.failure} messages={messages} />;
  if (!page) return null;
  const t = entityCopy(locale);
  return <details className="group min-w-0 border-border/70 border-y" data-full-facts>
    <summary className="flex cursor-pointer list-none items-center gap-2 py-4 font-semibold outline-none
      focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {materializeData(messages, { locale }).fullFacts}
      <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-5 pb-6">
      <WorkFactsView page={page} labels={labels} names={names}
        hrefFor={selection.hrefFor} cursor={selection.cursor} locale={locale} t={t} messages={messages} />
      <ProposeCorrectionSlot work={id} locale={locale} messages={messages} />
    </div>
  </details>;
}

/**
 * Your edition and availability: the reader's choice first, then the Work's realizations and releases with a
 * way into the full inventory. A series has no editions of its own, but its reader still chooses a language
 * and the edition its parts are read in, so a Work with parts has the section too; one with neither does not.
 */
export async function Availability({ workRef, id, locale, messages, client }: Common & { workRef: WorkAt; id: string }) {
  const [work, projection] = await Promise.all([readWorkHeader(id, locale, client), readEntityProjection(id, undefined, client)]);
  if (work.ok && workExperience(projection.ok ? projection.data : null, work.data.types).kind === 'book') {
    return <BooksEditionPage work={work.data.id} releases={await readReleases(id, client)} locale={locale} messages={messages}
      signInHref={signInPath(localizedPath(workHref(workRef), locale))} editionsHref={editionsHref(workRef)} />;
  }
  const [realizations, releases, parts] = await Promise.all([readRealizations(id), readReleasePage(id),
    readParts(id, { limit: 1 })]);
  const none = (read: { ok: true; data: { items?: unknown[]; parts?: unknown[]; nextCursor?: string | null; next?: string | null } }
    | { ok: false; failure: string }) => {
    if (!read.ok) return false;
    const page = { entries: read.data.items, nextCursor: read.data.nextCursor };
    return !(page.entries ?? read.data.parts)?.length && !page.nextCursor && !read.data.next;
  };
  if (none(realizations) && none(releases) && none(parts)) return null;
  const t = materializeData(messages, { locale });
  return <Region id="work-availability" title={t.sectionAvailability}>
    <YourEdition work={iriOf(id)} locale={locale} messages={messages}
      signInHref={signInPath(localizedPath(workHref(workRef), locale))} />
    <EditionsPreviewView realizations={realizations} releases={releases} workRef={workRef} locale={locale}
      pageMessages={messages} t={levelsCopy(locale)} />
  </Region>;
}

/**
 * Parts and connections: the next unfinished part and the reader's series progress first, then the
 * parts and the typed relations. The edition choice is made once, in the availability section.
 * Main discloses structural previews publicly; personal progress still needs an eligible Agent.
 */
export async function Parts({ workRef, id, locale, messages, client }: Common & { workRef: WorkAt; id: string }) {
  const { actingSubject } = await readingAgent(client);
  const embedded = { id, workRef: workRefOf(workRef), locale, pageMessages: messages, client };
  return <>
    {actingSubject ? <SeriesProgressPanel work={iriOf(id)} locale={locale} preferenceForm={false} /> : null}
    <Suspense fallback={null}>{client ? PartsPreview(embedded) : <PartsPreview {...embedded} />}</Suspense>
    <Suspense fallback={null}>{client ? ConnectionsPreview(embedded) : <ConnectionsPreview {...embedded} />}</Suspense>
  </>;
}

/** The latest replies about the Work, with the way to start one, and the full discussion a link away. */
export async function DiscussionHub({ workRef, id, locale, messages, client }: Common & { workRef: WorkAt; id: string }) {
  const [page, { signedIn }] = await Promise.all([readEntityProjection(id, undefined, client), readingAgent(client)]);
  const section = page.ok ? sectionOf(page.data, 'discussion') : undefined;
  if (!page.ok) return <RegionFailure title={messages.sectionDiscussion} failure={page.failure} messages={messages} />;
  if (!section) return null;
  const t = materializeData(messages, { locale });
  const discussion = workHref(workRef, 'discussion');
  const hrefFor = standaloneHrefFor({}, entityHref(id));
  return <div className="grid gap-4" data-discussion-hub>
    {client ? DiscussionSection({ section, resource: page.data.target.resource,
      registry: page.data.registry, signedIn, preview: 3, anchor: 'work-discussion',
      hrefFor: link => link.kind === 'continue' ? discussion : hrefFor(link), locale, t: entityCopy(locale),
      messages, client }) : <DiscussionSection section={section} resource={page.data.target.resource}
      registry={page.data.registry} signedIn={signedIn} preview={3} anchor="work-discussion"
      hrefFor={link => link.kind === 'continue' ? discussion : hrefFor(link)} locale={locale} t={entityCopy(locale)}
      messages={messages} />}
    <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-sm">{t.discussionIntro}
      <Link href={discussion} className={buttonVariants({ variant: 'outline', size: 'sm', pill: true })}>
        {t.discussionOpen}</Link></p>
  </div>;
}
