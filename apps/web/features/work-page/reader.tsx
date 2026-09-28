import { Alert, AlertDescription } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, FileQuestionIcon, ListTreeIcon,
  TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { paragraphs } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { ChapterKeys, ReaderChrome, ReaderSurface, ReadingProgress } from './reader-client.tsx';
import { parsePosition, type ReaderSettings } from './reader-settings.ts';
import { RetryButton } from './retry-button.tsx';
import { chapterHref, idOf, workHref } from './route.ts';
import type { ChapterRead, Loaded, Progress, WorkHeader } from './types.ts';

/** A chapter's heading: its title, or "Chapter 3" by its place when it has none, never "Untitled chapter". */
export function chapterTitle(label: { value: string } | null, ordinal: number,
  t: Pick<ReturnType<typeof materializeData<WorkPageMessages>>, 'chapterNumber'>): string {
  return label?.value.trim() || t.chapterNumber(ordinal);
}

const folded = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase();

/**
 * The body without a first line that only repeats the chapter's title, as
 * imported text often opens with it ("第一章 雨夜"); the reader sets the
 * title once, as the heading.
 */
export function bodyAfterTitle(lines: string[], title: string | undefined): string[] {
  return title && lines.length > 1 && folded(lines[0]!) === folded(title) ? lines.slice(1) : lines;
}

function ProgressPanel({ progress, chapter, actingSubject, here, locale, messages }: {
  progress: Loaded<Progress>; chapter: ChapterRead; actingSubject: string | null; here: string; locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = messages;
  if (progress.ok && actingSubject) {
    return <ReadingProgress target={chapter.progress} actingSubject={actingSubject} initial={progress.data}
      labels={{ progress: t.progress, markRead: t.markRead, chapterRead: t.chapterRead, markUnread: t.markUnread,
        saving: t.saving, progressFailed: t.progressFailed }} />;
  }
  const failure = progress.ok ? 'identity' : progress.failure;
  const back = localizedPath(here, locale);
  const step = failure === 'sign-in' ? { text: t.progressSignIn, label: t.signIn, href: signInPath(back) }
    : failure === 'identity' ? { text: t.progressIdentity, label: t.chooseIdentity,
      href: localizedPath(`/identity?next=${encodeURIComponent(back)}`, locale) } : null;
  return <div className="grid justify-items-start gap-2 text-sm">
    <p className="font-medium">{t.progress}</p>
    {step ? <p className="flex flex-wrap items-center gap-2 text-muted-foreground">{step.text}
      <Link href={step.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
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
  const title = chapterTitle(chapter.label, chapter.ordinal, t);
  const lines = typeof body === 'string' ? bodyAfterTitle(paragraphs(body), chapter.label?.value) : null;
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
      <ReaderSurface initial={settings} actingSubject={actingSubject} toolbar={toolbar}
        labels={{ settings: t.settings, textSize: t.textSize,
        smallerText: t.smallerText, largerText: t.largerText, lineWidth: t.lineWidth, narrow: t.narrow,
        medium: t.medium, wide: t.wide, typeface: t.typeface, serif: t.serif, sans: t.sans,
        settingsLocal: t.settingsLocal, paragraphIndent: t.paragraphIndent, theme: t.theme,
        system: t.system, light: t.light, dark: t.dark, cjkSpacing: t.cjkSpacing,
        cjkAuto: t.cjkAuto, cjkNone: t.cjkNone, cjkPunctuation: t.cjkPunctuation,
        cjkStandard: t.cjkStandard, cjkStrict: t.cjkStrict, settingsFailed: t.settingsFailed }}>
        <article lang={chapter.language} dir={direction === 'none' ? undefined : direction}
          className="mx-auto grid w-full max-w-(--reader-width) gap-6">
          <header className="grid gap-2 border-border/60 border-b pb-4">
            {chapter.parentPath.map(item => <span key={item.occurrence} lang={item.label?.language}
              className="text-muted-foreground text-sm">{item.label?.value ?? t.untitledPart}</span>)}
            <h1 lang={chapter.label?.language ?? locale}
              className="text-balance font-semibold font-work-title text-2xl/tight sm:text-3xl/tight">{title}</h1>
            {resume ? <a href={`#p-${resume}`} className={cn(buttonVariants({ size: 'sm', variant: 'soft' }),
              'justify-self-start')}>{t.continueReading}</a> : null}
          </header>
          {/* Latin text reads well at 1.7; Chinese and Japanese, set solid, need 1.8. */}
          {lines ? <div className="grid gap-[0.9em] text-(length:--reader-size) leading-[1.7] text-pretty
            [&:lang(ja)]:leading-[1.8] [&:lang(zh)]:leading-[1.8]
            group-data-[face=serif]/reader:font-work-title
            group-data-[indent=true]/reader:[&>p]:indent-[2em]
            group-data-[cjk-spacing=none]/reader:[text-autospace:no-autospace]
            group-data-[cjk-punctuation=strict]/reader:[line-break:strict]">
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
          <ProgressPanel progress={progress} chapter={chapter} actingSubject={actingSubject} here={here} locale={locale}
            messages={messages} />
        </div>
      </ReaderSurface>
      <ChapterKeys previous={previous && localizedPath(previous, locale)} next={next && localizedPath(next, locale)}
        direction={direction} />
      <ReaderChrome />
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
