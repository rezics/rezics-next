import { FileQuestionIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { languageName } from './format.ts';
import { WorkCredits } from './credits.tsx';
import type { WorkPageMessages } from './messages.ts';
import {
  TextNotFound,
  TextReader,
  TextUnavailable,
} from './reader.tsx';
import type { ReaderSettings } from './reader-settings.ts';
import type { BooksLanguageReading } from './books-language-recorded-page.ts';

/** The recorded content language, named in the UI locale and kept as its own tag. */
function BooksLanguageIdentity({
  language,
  locale,
  messages,
}: {
  language: string;
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
    </div>
  );
}

function identityFor(
  reading: Extract<BooksLanguageReading, { kind: 'reading' }>,
  locale: UiLocale,
  messages: WorkPageMessages,
): ReactNode {
  return (
    <>
      <BooksLanguageIdentity language={reading.language} locale={locale} messages={messages} />
      <WorkCredits agentCredits={reading.agentCredits} credits={reading.credits}
        locale={locale} messages={messages} />
    </>
  );
}

/**
 * The recorded text and its language. Loading and a recorded text refusal
 * are the other states this route draws. A missing Work is the route's not-found page.
 */
export function BooksLanguageRecordedView({
  reading,
  workRef,
  settings,
  actingSubject,
  locale,
  messages,
  linkLanguage,
  fetcher,
}: {
  reading: BooksLanguageReading | { kind: 'loading' };
  workRef: string;
  settings: ReaderSettings;
  actingSubject: string | null;
  locale: UiLocale;
  messages: WorkPageMessages;
  /** Contents link language from the page address. The article keeps the text's own language. */
  linkLanguage?: string;
  /** A story's replaying fetch. Production uses the browser's own Main client. */
  fetcher?: typeof fetch;
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
  if (reading.kind === 'missing') return <TextNotFound workRef={workRef} messages={messages} />;
  if (reading.kind === 'unavailable')
    return <TextUnavailable workRef={workRef} messages={messages} />;
  const identity = identityFor(reading, locale, messages);
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
      fetcher={fetcher}
    />
  );
}
