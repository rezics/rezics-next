import { FileQuestionIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { authorHref } from '../author/route.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { languageName, paragraphs } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import {
  bodyAfterTitle,
  ReaderText,
  TextNotFound,
  TextReader,
  TextUnavailable,
} from './reader.tsx';
import type { ReaderSettings } from './reader-settings.ts';
import type { BooksLanguageCredit, BooksLanguageReading } from './books-language-recorded-page.ts';

/** The recorded content language and the credited author. A missing name stays the agent. */
function BooksLanguageIdentity({
  language,
  credit,
  locale,
  messages,
}: {
  language: string;
  credit: BooksLanguageCredit | null;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const name = languageName(language, locale);
  return (
    <div className="grid gap-1 text-sm">
      <p>
        <span className="text-muted-foreground">{messages.language}</span>{' '}
        <span className="font-mono">{language}</span>
        {name === language ? null : <span lang={locale}> {name}</span>}
      </p>
      {credit ? (
        <p className="break-all">
          <span className="text-muted-foreground">{messages.author}</span>{' '}
          <Link
            href={authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })}
            className="break-all font-mono text-xs text-primary underline underline-offset-4"
          >
            {credit.displayName ?? credit.agent}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function identityFor(
  reading: Extract<BooksLanguageReading, { kind: 'reading' }>,
  locale: UiLocale,
  messages: WorkPageMessages,
): ReactNode {
  return (
    <BooksLanguageIdentity
      language={reading.language}
      credit={reading.credit}
      locale={locale}
      messages={messages}
    />
  );
}

/**
 * The recorded text, its language and its credit. Loading, an authorized empty
 * record and a recorded refusal are the other states the answers prove.
 */
export function BooksLanguageRecordedView({
  reading,
  workRef,
  settings,
  actingSubject,
  locale,
  messages,
  linkLanguage,
}: {
  reading: BooksLanguageReading | { kind: 'loading' };
  workRef: string;
  settings: ReaderSettings;
  actingSubject: string | null;
  locale: UiLocale;
  messages: WorkPageMessages;
  /** Contents link language from the page address. The article keeps the text's own language. */
  linkLanguage?: string;
}) {
  if (reading.kind === 'loading') {
    return (
      <p role="status" className="px-4 py-10 text-sm text-muted-foreground">
        {messages.loading}
      </p>
    );
  }
  if (reading.kind === 'refused') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <EmptyState
          icon={FileQuestionIcon}
          headingLevel={1}
          role="alert"
          title={reading.problem.title}
        />
      </div>
    );
  }
  if (reading.kind === 'empty') {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <EmptyState
          icon={FileQuestionIcon}
          headingLevel={1}
          role="status"
          title={messages.noContents}
          description={messages.noContentsBody}
        >
          <p className="max-w-full text-muted-foreground text-xs">
            {messages.workId} <span className="break-all font-mono">{reading.workId}</span>
          </p>
        </EmptyState>
      </div>
    );
  }
  if (reading.kind === 'missing') return <TextNotFound workRef={workRef} messages={messages} />;
  if (reading.kind === 'unavailable')
    return <TextUnavailable workRef={workRef} messages={messages} />;
  const identity = identityFor(reading, locale, messages);
  if (reading.header) {
    return (
      <TextReader
        workRef={workRef}
        work={reading.header}
        text={reading.text}
        language={linkLanguage}
        settings={settings}
        actingSubject={actingSubject}
        locale={locale}
        messages={messages}
        identity={identity}
      />
    );
  }
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <article lang={reading.language} dir="auto" className="mx-auto grid w-full max-w-3xl gap-6">
        <header className="grid gap-2 border-border/60 border-b pb-4">
          <h1
            lang={reading.title.language}
            dir={reading.title.direction ?? 'auto'}
            className="text-balance break-words font-semibold font-work-title text-2xl/tight sm:text-3xl/tight"
          >
            {reading.title.value}
          </h1>
          {identity}
        </header>
        <ReaderText
          lines={bodyAfterTitle(paragraphs(reading.body), reading.title.value)}
          document={reading.text.document}
          formatNote={messages.textFormat}
          locale={locale}
        />
      </article>
    </div>
  );
}
