import { Alert, AlertDescription } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, FileQuestionIcon, ListTreeIcon,
  TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { paragraphs } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { ChapterKeys, ReaderSurface, ReadingProgress } from './reader-client.tsx';
import { parsePosition, type ReaderSettings } from './reader-settings.ts';
import { RetryButton } from './retry-button.tsx';
import { chapterHref, idOf, workHref } from './route.ts';
import type { ChapterRead, Loaded, Progress, WorkHeader } from './types.ts';

function ProgressPanel({ progress, chapter, actingSubject, here, messages }: {
  progress: Loaded<Progress>; chapter: ChapterRead; actingSubject: string | null; here: string;
  messages: WorkPageMessages;
}) {
  const t = messages;
  if (progress.ok && actingSubject) {
    return <ReadingProgress target={chapter.progress} actingSubject={actingSubject} initial={progress.data}
      labels={{ progress: t.progress, markRead: t.markRead, chapterRead: t.chapterRead, markUnread: t.markUnread,
        saving: t.saving, progressFailed: t.progressFailed }} />;
  }
  const failure = progress.ok ? 'identity' : progress.failure;
  const step = failure === 'sign-in' ? { text: t.progressSignIn, label: t.signIn, path: '/sign-in' }
    : failure === 'identity' ? { text: t.progressIdentity, label: t.chooseIdentity, path: '/identity' } : null;
  return <div className="grid justify-items-start gap-2 text-sm">
    <p className="font-medium">{t.progress}</p>
    {step ? <p className="flex flex-wrap items-center gap-2 text-muted-foreground">{step.text}
      <Link href={`${step.path}?next=${encodeURIComponent(here)}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        {step.label}</Link></p>
      : failure === 'missing' ? <p className="text-muted-foreground">{t.progressUnavailable}</p>
        : <p className="flex flex-wrap items-center gap-2 text-destructive-foreground">{t.progressFailed}
          <RetryButton label={t.retry} pendingLabel={t.retrying} /></p>}
  </div>;
}

/**
 * The chapter reader: the Work and Contents to go back to, the exact
 * published text in its own language and direction, previous and next
 * chapters (also on ← and →), reading settings, and the reader's progress.
 */
export function ChapterReader({ workRef, work, chapter, language, settings, progress, actingSubject, locale,
  messages }: {
  workRef: string; work: WorkHeader; chapter: ChapterRead; language: string | undefined; settings: ReaderSettings;
  progress: Loaded<Progress>; actingSubject: string | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const body: unknown = chapter.content.body.body;
  const lines = typeof body === 'string' ? paragraphs(body) : null;
  const direction = chapter.content.reference.direction;
  const neighbour = (occurrence: string | null) => {
    const id = occurrence ? idOf(occurrence) : null;
    return id ? chapterHref(workRef, id, language) : null;
  };
  const previous = neighbour(chapter.previous);
  const next = neighbour(chapter.next);
  const here = chapterHref(workRef, idOf(chapter.occurrence) ?? '', language);
  const resume = progress.ok && !progress.data.completed ? parsePosition(progress.data.position) : null;
  const toolbar = <nav aria-label={t.workLink} className="flex flex-wrap items-center gap-1">
    <Link href={workHref(workRef)} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-w-72')}>
      <ArrowLeftIcon aria-hidden="true" />
      <span lang={work.title.language} className="truncate">{work.title.value}</span></Link>
    <Link href={workHref(workRef, 'contents', null, { language })} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
      <ListTreeIcon aria-hidden="true" />{t.contents}</Link>
  </nav>;
  const step = (href: string | null, label: string, edge: string, forward: boolean) => {
    const Icon = forward ? ChevronRightIcon : ChevronLeftIcon;
    const content = forward ? <>{label}<Icon aria-hidden="true" /></> : <><Icon aria-hidden="true" />{label}</>;
    return href ? <Link href={href} rel={forward ? 'next' : 'prev'}
      className={cn(buttonVariants({ variant: forward ? 'default' : 'outline' }), forward && 'ms-auto')}>{content}</Link>
      : <span title={edge} aria-disabled="true" className={cn(buttonVariants({ variant: 'outline' }),
        'pointer-events-none opacity-50', forward && 'ms-auto')}>{content}</span>;
  };
  // A plain reading ground in place of the gridded page canvas; CJK text spaces itself from Latin and digits.
  return <div className="min-h-dvh bg-background [text-autospace:normal]">
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <ReaderSurface initial={settings} toolbar={toolbar} labels={{ settings: t.settings, textSize: t.textSize,
        smallerText: t.smallerText, largerText: t.largerText, lineWidth: t.lineWidth, narrow: t.narrow,
        medium: t.medium, wide: t.wide, typeface: t.typeface, serif: t.serif, sans: t.sans,
        settingsLocal: t.settingsLocal }}>
        <article lang={chapter.language} dir={direction === 'none' ? undefined : direction}
          className="mx-auto grid w-full max-w-(--reader-width) gap-6">
          <header className="grid gap-2 border-border/60 border-b pb-4">
            <h1 lang={work.title.language} className="text-balance font-semibold font-work-title text-2xl/tight
              sm:text-3xl/tight">{work.title.value}</h1>
            {resume ? <a href={`#p-${resume}`} className={cn(buttonVariants({ size: 'sm', variant: 'soft' }),
              'justify-self-start')}>{t.continueReading}</a> : null}
          </header>
          {lines ? <div className="grid gap-[0.9em] text-(length:--reader-size) leading-[1.8] text-pretty
            group-data-[face=serif]/reader:font-work-title">
            {lines.map((line, index) => <p key={index} id={`p-${index}`} data-paragraph={index}
              className="scroll-mt-24">{line}</p>)}
          </div> : <Alert variant="warning"><CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{t.chapterFormat}</AlertDescription></Alert>}
        </article>
        <div className="mx-auto grid w-full max-w-(--reader-width) gap-6 border-border/60 border-t pt-6">
          <nav aria-label={t.chapterNavigation} className="flex flex-wrap items-center gap-2">
            {step(previous, t.previousChapter, t.firstChapter, false)}
            {step(next, t.nextChapter, t.lastChapter, true)}
          </nav>
          <p className="hidden text-muted-foreground text-xs sm:block">{t.keyboardHint}</p>
          <ProgressPanel progress={progress} chapter={chapter} actingSubject={actingSubject} here={here}
            messages={messages} />
        </div>
      </ReaderSurface>
      <ChapterKeys previous={previous} next={next} direction={direction} />
    </div>
  </div>;
}

/** No chapter has this address in the Work's current contents, or it is not published in this language. */
export function ChapterNotFound({ workRef, messages }: { workRef: string; messages: WorkPageMessages }) {
  return <div className="mx-auto w-full max-w-3xl px-4 py-10">
    <EmptyState icon={FileQuestionIcon} headingLevel={1} title={messages.chapterNotFoundTitle}
      description={messages.chapterNotFoundBody}>
      <Link href={workHref(workRef, 'contents')} className={buttonVariants()}>{messages.contents}</Link>
    </EmptyState>
  </div>;
}

/** Main could not return the chapter; it may still exist. */
export function ChapterUnavailable({ workRef, messages }: { workRef: string; messages: WorkPageMessages }) {
  return <div className="mx-auto w-full max-w-3xl px-4 py-10">
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
      title={messages.chapterUnavailableTitle} description={messages.regionUnavailable}>
      <RetryButton label={messages.retry} pendingLabel={messages.retrying} />
      <Link href={workHref(workRef, 'contents')} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {messages.contents}</Link>
    </EmptyState>
  </div>;
}
