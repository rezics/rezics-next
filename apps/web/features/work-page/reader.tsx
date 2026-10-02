import { Alert, AlertDescription } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { checkDocument, documentParagraphs } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';
import { messages as documentMessages } from '../document-editor/messages.ts';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileQuestionIcon,
  ListTreeIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { numberedTitle, paragraphs, volumeName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { ChapterKeys, ReaderChrome, ReaderSurface, ReadingProgress } from './reader-client.tsx';
import { parsePosition, type ReaderSettings } from './reader-settings.ts';
import { RetryButton } from './retry-button.tsx';
import { chapterHref, idOf, workHref } from './route.ts';
import type { ChapterRead, Loaded, Progress, WorkHeader, WorkText } from './types.ts';

/** A chapter's heading: its title, or "Chapter 3" by its place when it has none, never "Untitled chapter". */
export function chapterTitle(
  label: { value: string } | null,
  ordinal: number,
  t: Pick<ReturnType<typeof materializeData<WorkPageMessages>>, 'chapterNumber'>,
): string {
  return label?.value.trim() || t.chapterNumber(ordinal);
}

/**
 * Where a chapter stands, above its title: "Volume 2 · Chapter 3" (第二卷 · 第3章)
 * in a volume, the part's own name in a part, the extras' name alone for 番外.
 * A title that already says its number keeps it; the line never repeats it.
 */
export function chapterContext(
  chapter: Pick<ChapterRead, 'parentPath' | 'number' | 'label'>,
  locale: UiLocale,
  t: ReturnType<typeof materializeData<WorkPageMessages>>,
): { group: string | null; chapter: string | null } {
  const group = chapter.parentPath.at(-1);
  const name = !group
    ? null
    : group.division === 'volume' && group.number
      ? volumeName(group.number, locale, t)
      : (group.label?.value ?? (group.division === 'extras' ? t.extras : t.untitledPart));
  const number =
    chapter.number && group?.division !== 'extras' && !numberedTitle(chapter.label?.value)
      ? t.chapterNumber(chapter.number)
      : null;
  return { group: name, chapter: number };
}

const folded = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[\s\p{P}]+/gu, '')
    .toLowerCase();

/**
 * The body without a first line that only repeats the chapter's title, as
 * imported text often opens with it ("第一章 雨夜"); the reader sets the
 * title once, as the heading.
 */
export function bodyAfterTitle(lines: string[], title: string | undefined): string[] {
  return title && lines.length > 1 && folded(lines[0]!) === folded(title) ? lines.slice(1) : lines;
}

function ProgressPanel({
  progress,
  chapter,
  actingSubject,
  here,
  locale,
  messages,
}: {
  progress: Loaded<Progress>;
  chapter: ChapterRead;
  actingSubject: string | null;
  here: string;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = messages;
  if (progress.ok && actingSubject) {
    return (
      <ReadingProgress
        target={chapter.progress}
        actingSubject={actingSubject}
        initial={progress.data}
        labels={{
          progress: t.progress,
          markRead: t.markRead,
          chapterRead: t.chapterRead,
          markUnread: t.markUnread,
          saving: t.saving,
          progressFailed: t.progressFailed,
        }}
      />
    );
  }
  const failure = progress.ok ? 'identity' : progress.failure;
  const back = localizedPath(here, locale);
  const step =
    failure === 'sign-in'
      ? { text: t.progressSignIn, label: t.signIn, href: signInPath(back) }
      : failure === 'identity'
        ? {
            text: t.progressIdentity,
            label: t.chooseIdentity,
            href: localizedPath(`/identity?next=${encodeURIComponent(back)}`, locale),
          }
        : null;
  return (
    <div className="grid justify-items-start gap-2 text-sm">
      <p className="font-medium">{t.progress}</p>
      {step ? (
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {step.text}
          <Link href={step.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
            {step.label}
          </Link>
        </p>
      ) : failure === 'missing' ? (
        <p className="text-muted-foreground">{t.progressUnavailable}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-destructive-foreground">
          {t.progressFailed}
          <RetryButton label={t.retry} pendingLabel={t.retrying} />
        </p>
      )}
    </div>
  );
}

type Translated = ReturnType<typeof materializeData<WorkPageMessages>>;

/** The way back: the Work by its title, and its Contents in the language being read, the chapter's volume open. */
function ReaderToolbar({
  workRef,
  work,
  language,
  open,
  t,
}: {
  workRef: string;
  work: WorkHeader;
  language: string | undefined;
  open?: string;
  t: Translated;
}) {
  return (
    <nav aria-label={t.workLink} className="flex flex-wrap items-center gap-1">
      <Link
        href={workHref(workRef)}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-w-72')}
      >
        <ArrowLeftIcon aria-hidden="true" />
        <span lang={work.title.language} className="truncate">
          {work.title.value}
        </span>
      </Link>
      <Link
        href={workHref(workRef, 'contents', null, { language, open })}
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        <ListTreeIcon aria-hidden="true" />
        {t.contents}
      </Link>
    </nav>
  );
}

const settingsLabels = (t: Translated) => ({
  settings: t.settings,
  textSize: t.textSize,
  smallerText: t.smallerText,
  largerText: t.largerText,
  lineWidth: t.lineWidth,
  narrow: t.narrow,
  medium: t.medium,
  wide: t.wide,
  typeface: t.typeface,
  serif: t.serif,
  sans: t.sans,
  settingsLocal: t.settingsLocal,
  paragraphIndent: t.paragraphIndent,
  theme: t.theme,
  system: t.system,
  light: t.light,
  dark: t.dark,
  cjkSpacing: t.cjkSpacing,
  cjkAuto: t.cjkAuto,
  cjkNone: t.cjkNone,
  cjkPunctuation: t.cjkPunctuation,
  cjkStandard: t.cjkStandard,
  cjkStrict: t.cjkStrict,
  settingsFailed: t.settingsFailed,
});

/** The reading page around an article: a plain ground, the reading settings, and the phone chrome that steps aside. */
function ReaderPage({
  settings,
  actingSubject,
  toolbar,
  t,
  children,
  after,
}: {
  settings: ReaderSettings;
  actingSubject: string | null;
  toolbar: ReactNode;
  t: Translated;
  children: ReactNode;
  /** Outside the reading column: chapter keys. */
  after?: ReactNode;
}) {
  // A plain reading ground in place of the gridded page canvas; CJK text spaces itself from Latin and digits.
  return (
    <div className="min-h-dvh bg-background [text-autospace:normal]">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
        <ReaderSurface
          initial={settings}
          actingSubject={actingSubject}
          toolbar={toolbar}
          labels={settingsLabels(t)}
        >
          {children}
        </ReaderSurface>
        {after}
        <ReaderChrome />
      </div>
    </div>
  );
}

/** The text in paragraphs, with the reader's type settings; a note when the reader can't show its format. */
export function ReaderText({
  lines,
  document,
  formatNote,
  locale = 'en',
}: {
  lines: string[] | null;
  document?: unknown;
  formatNote: string;
  locale?: UiLocale;
}) {
  if (checkDocument(document)) {
    const positions = new Map(documentParagraphs(document).map((unit, index) => [unit.id, index]));
    return (
      <DocumentBody
        document={document}
        data-reader-text=""
        unknownComponentLabel={documentMessages[locale].unknownComponent}
        spoilerLabel={documentMessages[locale].revealSpoiler}
        nodeAttributes={(node) => {
          const index = positions.get(String(node.attrs?.id));
          return index === undefined ? {} : { id: `p-${index}`, 'data-paragraph': index };
        }}
        className="text-(length:--reader-size) leading-[1.7] text-pretty
        [&:lang(ja)]:leading-[1.8] [&:lang(zh)]:leading-[1.8]
        group-data-[face=serif]/reader:font-work-title
        group-data-[indent=true]/reader:[&>p]:indent-[2em]
        group-data-[cjk-spacing=none]/reader:[text-autospace:no-autospace]
        group-data-[cjk-punctuation=strict]/reader:[line-break:strict]"
      />
    );
  }
  // Latin text reads well at 1.7; Chinese and Japanese, set solid, need 1.8.
  return lines ? (
    <div
      data-reader-text=""
      className="grid gap-[0.9em] text-(length:--reader-size) leading-[1.7]
    text-pretty [&:lang(ja)]:leading-[1.8] [&:lang(zh)]:leading-[1.8]
    group-data-[face=serif]/reader:font-work-title
    group-data-[indent=true]/reader:[&>p]:indent-[2em]
    group-data-[cjk-spacing=none]/reader:[text-autospace:no-autospace]
    group-data-[cjk-punctuation=strict]/reader:[line-break:strict]"
    >
      {lines.map((line, index) => (
        <p key={index} id={`p-${index}`} data-paragraph={index} className="scroll-mt-24">
          {line}
        </p>
      ))}
    </div>
  ) : (
    <Alert variant="warning">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription>{formatNote}</AlertDescription>
    </Alert>
  );
}

/**
 * The chapter reader: the Work and Contents to go back to, the exact
 * published text in its own language and direction, previous and next
 * chapters (also on ← and →), reading settings, and the reader's progress.
 */
export function ChapterReader({
  workRef,
  work,
  chapter,
  language,
  settings,
  progress,
  actingSubject,
  locale,
  messages,
}: {
  workRef: string;
  work: WorkHeader;
  chapter: ChapterRead;
  language: string | undefined;
  settings: ReaderSettings;
  progress: Loaded<Progress>;
  actingSubject: string | null;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const body: unknown = chapter.content.body.body;
  const title = chapterTitle(chapter.label, chapter.number ?? chapter.ordinal, t);
  const context = chapterContext(chapter, locale, t);
  const group = chapter.parentPath.at(-1);
  const volume = group ? (idOf(group.occurrence) ?? undefined) : undefined;
  const lines =
    typeof body === 'string' ? bodyAfterTitle(paragraphs(body), chapter.label?.value) : null;
  const direction = chapter.content.reference.direction;
  const neighbour = (occurrence: string | null) => {
    const id = occurrence ? idOf(occurrence) : null;
    return id ? chapterHref(workRef, id, language) : null;
  };
  const previous = neighbour(chapter.previous);
  const next = neighbour(chapter.next);
  const here = chapterHref(workRef, idOf(chapter.occurrence) ?? '', language);
  const resume =
    progress.ok && !progress.data.completed ? parsePosition(progress.data.position) : null;
  const step = (href: string | null, label: string, edge: string, forward: boolean) => {
    const Icon = forward ? ChevronRightIcon : ChevronLeftIcon;
    const content = forward ? (
      <>
        {label}
        <Icon aria-hidden="true" />
      </>
    ) : (
      <>
        <Icon aria-hidden="true" />
        {label}
      </>
    );
    return href ? (
      <Link
        href={href}
        rel={forward ? 'next' : 'prev'}
        className={cn(
          buttonVariants({ variant: forward ? 'default' : 'outline' }),
          forward && 'ms-auto',
        )}
      >
        {content}
      </Link>
    ) : (
      <span
        title={edge}
        aria-disabled="true"
        className={cn(
          buttonVariants({ variant: 'outline' }),
          'pointer-events-none opacity-50',
          forward && 'ms-auto',
        )}
      >
        {content}
      </span>
    );
  };
  return (
    <ReaderPage
      settings={settings}
      actingSubject={actingSubject}
      t={t}
      toolbar={
        <ReaderToolbar workRef={workRef} work={work} language={language} open={volume} t={t} />
      }
      after={
        <ChapterKeys
          previous={previous && localizedPath(previous, locale)}
          next={next && localizedPath(next, locale)}
          direction={direction}
        />
      }
    >
      <article
        lang={chapter.language}
        dir={direction === 'none' ? undefined : direction}
        className="mx-auto grid w-full max-w-(--reader-width) gap-6"
      >
        <header className="grid gap-2 border-border/60 border-b pb-4">
          {context.group || context.chapter ? (
            <p
              className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground
          text-sm"
            >
              {context.group ? (
                <Link
                  href={workHref(workRef, 'contents', null, { language, open: volume })}
                  lang={group?.division === 'volume' ? locale : group?.label?.language}
                  className="rounded-sm underline-offset-4 hover:text-foreground hover:underline"
                >
                  {context.group}
                </Link>
              ) : null}
              {context.group && context.chapter ? <span aria-hidden="true">·</span> : null}
              {context.chapter ? <span lang={locale}>{context.chapter}</span> : null}
            </p>
          ) : null}
          <h1
            lang={chapter.label?.language ?? locale}
            className="text-balance font-semibold font-work-title text-2xl/tight sm:text-3xl/tight"
          >
            {title}
          </h1>
          {resume ? (
            <a
              href={`#p-${resume}`}
              className={cn(buttonVariants({ size: 'sm', variant: 'soft' }), 'justify-self-start')}
            >
              {t.continueReading}
            </a>
          ) : null}
        </header>
        <ReaderText
          lines={lines}
          document={chapter.content.body.document}
          formatNote={t.chapterFormat}
          locale={locale}
        />
      </article>
      <div className="mx-auto grid w-full max-w-(--reader-width) gap-6 border-border/60 border-t pt-6">
        <nav aria-label={t.chapterNavigation} className="flex flex-wrap items-center gap-2">
          {step(previous, t.previousChapter, t.firstChapter, false)}
          {step(next, t.nextChapter, t.lastChapter, true)}
        </nav>
        <p className="hidden text-muted-foreground text-xs sm:block">{t.keyboardHint}</p>
        <ProgressPanel
          progress={progress}
          chapter={chapter}
          actingSubject={actingSubject}
          here={here}
          locale={locale}
          messages={messages}
        />
      </div>
    </ReaderPage>
  );
}

/**
 * The reader of a Work read as one text: its Main Version's selected
 * publication under the Work's title, with the same settings as a chapter and
 * nothing to step to. Main keeps reading progress per chapter, so there is
 * none to show here.
 */
export function TextReader({
  workRef,
  work,
  text,
  language,
  settings,
  actingSubject,
  locale,
  messages,
}: {
  workRef: string;
  work: WorkHeader;
  text: WorkText;
  language: string | undefined;
  settings: ReaderSettings;
  actingSubject: string | null;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  return (
    <ReaderPage
      settings={settings}
      actingSubject={actingSubject}
      t={t}
      toolbar={<ReaderToolbar workRef={workRef} work={work} language={language} t={t} />}
    >
      <article
        lang={text.language}
        dir="auto"
        className="mx-auto grid w-full max-w-(--reader-width) gap-6"
      >
        <header className="grid gap-2 border-border/60 border-b pb-4">
          <h1
            lang={work.title.language}
            dir={work.title.direction}
            className="text-balance font-semibold font-work-title text-2xl/tight sm:text-3xl/tight"
          >
            {work.title.value}
          </h1>
        </header>
        <ReaderText
          lines={bodyAfterTitle(paragraphs(text.body), work.title.value)}
          document={text.document}
          formatNote={t.textFormat}
          locale={locale}
        />
      </article>
    </ReaderPage>
  );
}

/** No chapter has this address in the Work's current contents, or it is not published in this language. */
export function ChapterNotFound({
  workRef,
  messages,
}: {
  workRef: string;
  messages: WorkPageMessages;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <EmptyState
        icon={FileQuestionIcon}
        headingLevel={1}
        title={messages.chapterNotFoundTitle}
        description={messages.chapterNotFoundBody}
      >
        <Link href={workHref(workRef, 'contents')} className={buttonVariants()}>
          {messages.contents}
        </Link>
      </EmptyState>
    </div>
  );
}

/** The Work has no text to read as one: none in this language, or it is read by chapter. */
export function TextNotFound({
  workRef,
  messages,
}: {
  workRef: string;
  messages: WorkPageMessages;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <EmptyState
        icon={FileQuestionIcon}
        headingLevel={1}
        title={messages.textNotFoundTitle}
        description={messages.textNotFoundBody}
      >
        <Link href={workHref(workRef, 'contents')} className={buttonVariants()}>
          {messages.contents}
        </Link>
      </EmptyState>
    </div>
  );
}

/** Main could not return the Work's text; it may still exist. */
export function TextUnavailable({
  workRef,
  messages,
}: {
  workRef: string;
  messages: WorkPageMessages;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <EmptyState
        icon={TriangleAlertIcon}
        tone="destructive"
        role="alert"
        headingLevel={1}
        title={messages.textUnavailableTitle}
        description={messages.regionUnavailable}
      >
        <RetryButton label={messages.retry} pendingLabel={messages.retrying} />
        <Link
          href={workHref(workRef)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {messages.workLink}
        </Link>
      </EmptyState>
    </div>
  );
}

/** Main could not return the chapter; it may still exist. */
export function ChapterUnavailable({
  workRef,
  messages,
}: {
  workRef: string;
  messages: WorkPageMessages;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <EmptyState
        icon={TriangleAlertIcon}
        tone="destructive"
        role="alert"
        headingLevel={1}
        title={messages.chapterUnavailableTitle}
        description={messages.regionUnavailable}
      >
        <RetryButton label={messages.retry} pendingLabel={messages.retrying} />
        <Link
          href={workHref(workRef, 'contents')}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {messages.contents}
        </Link>
      </EmptyState>
    </div>
  );
}
