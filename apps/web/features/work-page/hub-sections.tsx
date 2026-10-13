import { buttonVariants } from '@rezics/ui/button';
import { ChevronDownIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { readEntityProjection, sectionOf } from '../entity-page/read.ts';
import { workExperience } from '../entity-page/experience.ts';
import { entityHref, standaloneHrefFor } from '../entity-page/route.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import { DiscussionSection, StatementsSection } from '../entity-page/sections.tsx';
import Link from '../shell/localized-link.tsx';
import { SeriesProgressPanel } from '../tracking/series-progress-panel.tsx';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { readParts, readRealizations, readReleases as readReleasePage } from '../work-levels/read.ts';
import { ConnectionsPreview, PartsPreview } from '../work-levels/previews-server.tsx';
import { EditionsPreviewView } from '../work-levels/previews.tsx';
import { editionsHref } from '../work-levels/route.ts';
import type { WorkPageMessages } from './messages.ts';
import { IdentityStatus, nextAction, NextActionView } from './primary-action.tsx';
import { ProposeCorrectionSlot } from './correction-slot.tsx';
import { readEditionPreference, readProgressSummary, readReleases, readStart, readingAgent, readWorkHeader } from './read.ts';
import { Region } from './region.tsx';
import { iriOf, workHref, type WorkAt, workRefOf } from './route.ts';
import type { WorkHeader as Header } from './types.ts';
import { YourEdition } from './your-edition.tsx';
import { BooksEditionPage } from './books-edition-page.tsx';

// The server halves of the hub sections compose other owners' previews, controls and widgets.
// Each reads on its own under the caller's Suspense, so one failing leaves the rest of the page.

interface Common { locale: UiLocale; messages: WorkPageMessages }

/** Progress is counted in a language: the reader's chosen one, else the one the interface is in (as the series panel does). */
const progressLanguage = (preference: Awaited<ReturnType<typeof readEditionPreference>>, locale: UiLocale) =>
  preference.ok && preference.data ? preference.data.language : locale;

/**
 * The page's one primary action and the reader's status under it. Main decides: hosted text first, then the
 * next part its progress summary names, then choosing an edition; this maps the answers to a button.
 */
export async function PrimaryAction({ workRef, id, work, locale, messages }: Common & { workRef: WorkAt; id: string;
  work: Header }) {
  const [start, preference, releases] = await Promise.all([readStart(id, work.id, locale, work.selectedLanguage),
    readEditionPreference(id), readReleases(id)]);
  const progress = await readProgressSummary(id, progressLanguage(preference, locale));
  const action = nextAction({ start, progress, preference, releases: releases.ok ? releases.data.items.length : 0 });
  return action ? <NextActionView action={action} workRef={workRef} locale={locale} messages={messages} /> : null;
}

/**
 * The edition the reader chose and their progress, named in Main's words, under the primary action. A chosen
 * release is named by its own title; a chosen realization, which has none, by its language.
 */
export async function Status({ id, locale, messages }: Common & { id: string }) {
  const preference = await readEditionPreference(id);
  const [progress, releases] = await Promise.all([readProgressSummary(id, progressLanguage(preference, locale)),
    readReleases(id)]);
  const chosen = preference.ok ? preference.data?.edition : null;
  const release = chosen?.kind === 'release' && releases.ok ? releases.data.items.find(item => item.id === chosen.resource)
    : undefined;
  return <IdentityStatus progress={progress} preference={preference}
    editionName={release ? releaseChoiceName(release, locale, trackingCopy(locale)) : null}
    locale={locale} messages={messages} />;
}

/** "About" on expansion: every accepted fact with its sources, and the way to propose a correction. */
export async function AboutFacts({ id, locale, messages }: Common & { id: string }) {
  const page = await readEntityProjection(id);
  const section = page.ok ? sectionOf(page.data, 'statements') : undefined;
  if (!section) return null;
  const t = entityCopy(locale);
  return <details className="group min-w-0 border-border/70 border-y" data-full-facts>
    <summary className="flex cursor-pointer list-none items-center gap-2 py-4 font-semibold outline-none
      focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {materializeData(messages, { locale }).fullFacts}
      <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-5 pb-6">
      <StatementsSection section={section} cursor={undefined} hrefFor={standaloneHrefFor({}, entityHref(id))}
        locale={locale} t={t} messages={messages} />
      <ProposeCorrectionSlot work={id} locale={locale} messages={messages} />
    </div>
  </details>;
}

/**
 * Your edition and availability: the reader's choice first, then the Work's realizations and releases with a
 * way into the full inventory. A series has no editions of its own, but its reader still chooses a language
 * and the edition its parts are read in, so a Work with parts has the section too; one with neither does not.
 */
export async function Availability({ workRef, id, locale, messages }: Common & { workRef: WorkAt; id: string }) {
  const [work, projection] = await Promise.all([readWorkHeader(id, locale), readEntityProjection(id)]);
  if (work.ok && workExperience(projection.ok ? projection.data : null, work.data.types).kind === 'book') {
    return <BooksEditionPage work={work.data.id} releases={await readReleases(id)} locale={locale} messages={messages}
      signInHref={signInPath(localizedPath(workHref(workRef), locale))} editionsHref={editionsHref(workRefOf(workRef))} />;
  }
  const [realizations, releases, parts] = await Promise.all([readRealizations(id), readReleasePage(id),
    readParts(id, { limit: 1 })]);
  const none = (read: { ok: true; data: { items?: unknown[]; parts?: unknown[] } } | { ok: false; failure: string }) =>
    read.ok ? !(read.data.items ?? read.data.parts)?.length : read.failure === 'missing' || read.failure === 'sign-in'
      || read.failure === 'identity';
  if (none(realizations) && none(releases) && none(parts)) return null;
  const t = materializeData(messages, { locale });
  return <Region id="work-availability" title={t.sectionAvailability}>
    <YourEdition work={iriOf(id)} locale={locale} messages={messages}
      signInHref={signInPath(localizedPath(workHref(workRef), locale))} />
    <EditionsPreviewView realizations={realizations} releases={releases} workRef={workRefOf(workRef)} locale={locale}
      pageMessages={messages} t={levelsCopy(locale)} />
  </Region>;
}

/**
 * Parts and connections: the next unfinished part and the reader's series progress first, then the
 * parts and the typed relations. The edition choice is made once, in the availability section.
 * Main discloses structural previews publicly; personal progress still needs an eligible Agent.
 */
export async function Parts({ workRef, id, locale, messages }: Common & { workRef: WorkAt; id: string }) {
  const { actingSubject } = await readingAgent();
  const embedded = { id, workRef: workRefOf(workRef), locale, pageMessages: messages };
  return <>
    {actingSubject ? <SeriesProgressPanel work={iriOf(id)} locale={locale} preferenceForm={false} /> : null}
    <Suspense fallback={null}><PartsPreview {...embedded} /></Suspense>
    <Suspense fallback={null}><ConnectionsPreview {...embedded} /></Suspense>
  </>;
}

/** The latest replies about the Work, with the way to start one, and the full discussion a link away. */
export async function DiscussionHub({ workRef, id, locale, messages }: Common & { workRef: WorkAt; id: string }) {
  const [page, { signedIn }] = await Promise.all([readEntityProjection(id), readingAgent()]);
  const section = page.ok ? sectionOf(page.data, 'discussion') : undefined;
  if (!page.ok || !section) return null;
  const t = materializeData(messages, { locale });
  const discussion = workHref(workRef, 'discussion');
  const hrefFor = standaloneHrefFor({}, entityHref(id));
  return <div className="grid gap-4" data-discussion-hub>
    <DiscussionSection section={section} cursor={undefined} resource={page.data.target.resource}
      registry={page.data.registry} signedIn={signedIn} preview={3} anchor="work-discussion"
      hrefFor={link => link.kind === 'continue' ? discussion : hrefFor(link)} locale={locale} t={entityCopy(locale)}
      messages={messages} />
    <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground text-sm">{t.discussionIntro}
      <Link href={discussion} className={buttonVariants({ variant: 'outline', size: 'sm', pill: true })}>
        {t.discussionOpen}</Link></p>
  </div>;
}
