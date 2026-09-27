import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { FeatherIcon, PenLineIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { studioHref } from './agent.ts';
import { ManuscriptCover } from './manuscript-cover.tsx';
import type { StudioMessages } from './messages.ts';
import type { StudioHome as Home } from './read.ts';
import { studioAgentName } from './studio-frame.tsx';
import { idOf, type MyText, type Submission, type SubmissionState } from './types.ts';

type T = ContractOf<StudioMessages>;

/** A BCP 47 tag's name in the interface language ("zh-Hans" → "简体中文"), or the tag itself. */
export function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(tag) ?? tag; }
  catch { return tag; }
}

/** The editor address for one text, pinned to the revision Studio last saw so a reload opens it exactly. */
export function textHref(agent: AgentOption, work: string, text: string, revision?: string | null): string {
  return studioHref(agent, `/works/${idOf(work)}/write/${idOf(text)}${revision ? `?revision=${idOf(revision)}` : ''}`);
}

export function publicationBadge(state: MyText['publication'], t: T) {
  if (state === 'public') return <Badge variant="success">{t.statePublic}</Badge>;
  if (state === 'private') return <Badge variant="secondary">{t.statePrivate}</Badge>;
  return <Badge variant="outline">{t.stateDraft}</Badge>;
}

export function submissionState(state: SubmissionState, t: T): { text: string; variant: 'info' | 'success' | 'warning' | 'outline' } {
  switch (state) {
    case 'pending': return { text: t.submissionPending, variant: 'info' };
    case 'deciding': return { text: t.submissionDeciding, variant: 'info' };
    case 'accepted': return { text: t.submissionAccepted, variant: 'success' };
    case 'changes-requested': return { text: t.submissionChanges, variant: 'warning' };
    case 'rejected': return { text: t.submissionRejected, variant: 'outline' };
    case 'withdrawn': return { text: t.submissionWithdrawn, variant: 'outline' };
    case 'stale': return { text: t.submissionStale, variant: 'outline' };
    default: return { text: t.submissionPending, variant: 'info' };
  }
}

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return <section aria-labelledby={id} className="grid gap-3">
    <h2 id={id} className="flex items-baseline gap-2 font-semibold text-lg">{title}
      {count ? <span className="font-normal text-muted-foreground text-sm tabular-nums">{count}</span> : null}</h2>
    {children}
  </section>;
}

function TextRow({ text, agent, locale, t }: { text: MyText; agent: AgentOption; locale: UiLocale; t: T }) {
  const title = text.work?.title.value ?? t.untitled;
  const work = text.work?.id ?? null;
  return <li className="flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-3 shadow-(--aura-shadow-card)">
    <ManuscriptCover cover={text.work?.cover ?? null} title={title} language={text.work?.title.language}
      fallbackKey={text.id} actingSubject={agent.iri} />
    <div className="grid min-w-0 flex-1 gap-1.5">
      {work ? <Link href={studioHref(agent, `/works/${idOf(work)}`)} lang={text.work?.title.language}
        className="truncate font-medium font-work-title text-lg hover:underline">{title}</Link>
        : <p className="truncate font-medium font-work-title text-lg">{title}</p>}
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
        {publicationBadge(text.publication, t)}<span>{languageName(text.language, locale)}</span></p>
    </div>
    {work ? <Link href={textHref(agent, work, text.id, text.revision)}
      className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}>
      <PenLineIcon aria-hidden="true" /><span className="max-sm:sr-only">{t.continueWriting}</span></Link> : null}
  </li>;
}

function SubmissionRow({ submission, realm, agent, titles, t }: {
  submission: Submission; realm: string; agent: AgentOption; titles: Record<string, string>; t: T;
}) {
  const state = submissionState(submission.state, t);
  const title = titles[submission.work] ?? t.untitled;
  return <li className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/60 bg-card px-4 py-3">
    <Link href={studioHref(agent, `/works/${idOf(submission.work)}`)} className="min-w-0 truncate font-medium hover:underline">
      {title}</Link>
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={state.variant}>{state.text}</Badge><span className="text-muted-foreground">{realm}</span></span>
    {submission.publicReason ? <p className="basis-full text-muted-foreground text-sm">{submission.publicReason}</p> : null}
  </li>;
}

function Failure({ title, help, retry, t }: { title: string; help?: string; retry: boolean; t: T }) {
  return <Alert variant={retry ? 'destructive' : 'warning'}>
    <TriangleAlertIcon aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    {help || retry ? <AlertDescription className="grid justify-items-start gap-2">{help ? <p>{help}</p> : null}
      {retry ? <RetryButton label={t.retry} pendingLabel={t.retry} /> : null}</AlertDescription> : null}
  </Alert>;
}

// Submissions still open with the Realm come first, then decisions, newest first.
const open = new Set<SubmissionState>(['pending', 'deciding', 'changes-requested']);

/** Studio's home for one Agent: its drafts, what it published and what Realms are reviewing. */
export function StudioHome({ agent, home, moreHref, locale, messages }: {
  agent: AgentOption; home: Home; moreHref: string | null; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const newWork = <Link href={studioHref(agent, '/new')} className={buttonVariants({ size: 'lg' })}>
    <PlusIcon aria-hidden="true" />{t.newWork}</Link>;
  const texts = home.texts.ok ? home.texts.data.items : [];
  const drafts = texts.filter(text => text.publication === 'draft');
  const published = texts.filter(text => text.publication !== 'draft');
  const submissions = home.submissions.ok ? [...home.submissions.data].sort((a, b) =>
    Number(open.has(b.state)) - Number(open.has(a.state)) || b.updatedAt.localeCompare(a.updatedAt)) : [];
  const titles = Object.fromEntries(texts.flatMap(text => text.work ? [[text.work.id, text.work.title.value]] : []));
  const empty = home.texts.ok && !texts.length && (!home.submissions.ok || !submissions.length);
  return <PageContainer className="grid gap-8">
    <PageHeader title={t.studio} description={t.homeDescription({ agent: studioAgentName(agent, t) })} actions={newWork} />
    {empty ? <EmptyState icon={FeatherIcon} title={t.emptyTitle} description={t.emptyBody}>
      <Link href={studioHref(agent, '/new')} className={buttonVariants()}><PlusIcon aria-hidden="true" />{t.startWriting}</Link>
    </EmptyState> : <>
      {home.texts.ok ? <>
        <Section id="studio-drafts" title={t.drafts} count={drafts.length}>
          {drafts.length ? <ul className="grid gap-3">{drafts.map(text =>
            <TextRow key={text.id} text={text} agent={agent} locale={locale} t={t} />)}</ul>
            : <p className="text-muted-foreground text-sm">{t.draftsEmpty}</p>}
        </Section>
        <Section id="studio-published" title={t.published} count={published.length}>
          {published.length ? <ul className="grid gap-3">{published.map(text =>
            <TextRow key={text.id} text={text} agent={agent} locale={locale} t={t} />)}</ul>
            : <p className="text-muted-foreground text-sm">{t.publishedEmpty}</p>}
        </Section>
        {moreHref ? <Link href={moreHref} className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
          {t.loadMore}</Link> : null}
      </> : home.texts.failure === 'denied'
        ? <Failure title={t.worksDenied} help={t.worksDeniedHelp} retry={false} t={t} />
        : <Failure title={t.worksFailed} retry t={t} />}
      <Section id="studio-review" title={t.inReview} count={submissions.length}>
        {home.submissions.ok ? submissions.length ? <ul className="grid gap-2">{submissions.map(submission =>
          <SubmissionRow key={submission.id} submission={submission} agent={agent} titles={titles} t={t}
            realm={home.realms[submission.realm] ?? t.realmFallback} />)}</ul>
          : <p className="text-muted-foreground text-sm">{t.reviewEmpty}</p>
          : home.submissions.failure === 'unavailable' ? <Failure title={t.reviewsFailed} retry t={t} />
            : <p className="text-muted-foreground text-sm">{t.reviewsDenied}</p>}
      </Section>
    </>}
  </PageContainer>;
}
