import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { readContentRatings, type ContentRatingRead } from '../api/content-rating.ts';
import { anonymousMediaViewer } from '../api/media-viewer.ts';
import { authorHref } from '../author/route.ts';
import { WebRatedContentProvider } from '../document-editor/rated-content.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { BooksLanguageRecordedView } from './books-language-recorded-page.tsx';
import {
  booksLanguageReads,
  type BooksLanguagePage,
} from './books-language-recorded-page.ts';
import type { AgentCreditPage } from './types.ts';
import { languageName } from './format.ts';
import { messages } from './messages.ts';
import { defaultReaderSettings } from './reader-settings.ts';
import { textHref } from './route.ts';
import { WorkNotFound } from './work-states.tsx';

const record = books as AnswerRecord;
type Persona = AnswerPersona;
type Locale = UiLocale;
type ReadingRequest = { persona: Persona; locale: Locale; kind: 'published' | 'private'; hold?: boolean };

function sample(persona: Persona, label: string): AnswerSample {
  const found = record.personas[persona].find((item) => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found;
}

function recordedId(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )?.[0];
  if (!id) throw new Error(`Recorded path has no id: ${path}`);
  return id;
}

function actingSubjectOf(path: string): string | null {
  return new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function textOf(value: unknown): { language: string; body: string } {
  if (!value || typeof value !== 'object') throw new Error('Recorded selection is empty');
  const text = value as { language?: unknown; body?: unknown };
  if (typeof text.language !== 'string' || typeof text.body !== 'string') {
    throw new Error('Recorded selection has no text');
  }
  return { language: text.language, body: text.body };
}

function headerTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value) || !value.title) {
    throw new Error('Recorded header has no title');
  }
  const title = (value.title as { value?: unknown }).value;
  if (typeof title !== 'string') throw new Error('Recorded header title is empty');
  return title;
}

function problemTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { title?: unknown }).title !== 'string') {
    throw new Error('Recorded problem has no title');
  }
  return (value as { title: string }).title;
}

function selectionsFor(request: ReadingRequest): RecordedSelection[] {
  if (request.hold) return [{ label: 'reading-page-header', state: 'loading' }];
  if (request.kind === 'private') {
    if (request.persona === 'owner') {
      return [
        { label: 'private-reading-page-header', state: 'populated' },
        { label: 'private-reading-page-selection', state: 'error' },
      ];
    }
    return [{ label: 'private-reading-page-header', state: 'error' }];
  }
  const selections: RecordedSelection[] = [
    { label: 'reading-page-header', state: 'populated' },
    { label: 'reading-page-selection', state: 'populated' },
    { label: 'reading-page-agent-credits', state: 'populated' },
    { label: 'reading-page-credits', state: 'populated' },
    { label: 'reading-page-suitability', state: 'populated' },
  ];
  if (request.persona !== 'visitor') selections.push({ label: 'reader-settings', state: 'populated' });
  return selections;
}

function RecordedBooksLanguage({ request }: { request: ReadingRequest }) {
  const [reading, setReading] = useState<BooksLanguagePage | { kind: 'loading' }>({ kind: 'loading' });
  const [suitability, setSuitability] = useState<ContentRatingRead | null>(null);
  const [fetcher, setFetcher] = useState<typeof fetch | null>(null);
  const key = JSON.stringify(request);
  useEffect(() => {
    const current = JSON.parse(key) as ReadingRequest;
    const headerLabel = current.kind === 'private' ? 'private-reading-page-header' : 'reading-page-header';
    const actingSubject = actingSubjectOf(sample(current.persona, headerLabel).path);
    const replay = recordedFetch(record, current.persona, selectionsFor(current), { pathPrefix: BFF_PREFIX });
    const main = browserMainApi(window.location.origin, {
      anonymous: actingSubject === null,
      fetcher: replay.fetcher,
    });
    let mounted = true;
    void booksLanguageReads({ main, actingSubject: actingSubject ?? undefined })
      .readPage(recordedId(sample(current.persona, headerLabel).path))
      .then(async (next) => {
        const rating = next.kind === 'shown' && next.reading.kind === 'reading'
          ? await readContentRatings([next.reading.workId], next.actingSubject, replay.fetcher) : null;
        if (!mounted) return;
        setSuitability(rating);
        setFetcher(() => replay.fetcher);
        setReading(next);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        throw error;
      });
    return () => {
      mounted = false;
      replay.dispose();
    };
  }, [key]);
  const messagesFor = messages[request.locale];
  const workRef = recordedId(sample(
    request.persona,
    request.kind === 'private' ? 'private-reading-page-header' : 'reading-page-header',
  ).path);
  if (reading.kind === 'work-missing') return <WorkNotFound messages={messagesFor} />;
  return (
    <WebRatedContentProvider locale={request.locale}
      actingSubject={reading.kind === 'shown' ? reading.actingSubject : null}
      viewer={suitability?.viewer ?? { ...anonymousMediaViewer, ready: false }}
      resolve={async () => suitability?.ratings ?? {}}>
      <BooksLanguageRecordedView
        reading={reading.kind === 'shown' ? reading.reading : { kind: 'loading' }}
        workRef={workRef}
        settings={defaultReaderSettings}
        actingSubject={reading.kind === 'shown' ? reading.actingSubject : null}
        locale={request.locale}
        messages={messagesFor}
        fetcher={fetcher ?? undefined}
      />
    </WebRatedContentProvider>
  );
}

const publishedRef = recordedId(sample('visitor', 'reading-page-header').path);

const meta = {
  title: 'Work page/Recorded content language',
  component: RecordedBooksLanguage,
  args: { request: { persona: 'visitor', locale: 'en', kind: 'published' } },
  parameters: {
    viewport: { options: { desktop: { name: 'Desktop (1440 × 900)', styles: { width: '1440px', height: '900px' }, type: 'desktop' } } },
    controls: { disable: true },
    route: { pathname: textHref(publishedRef) },
  },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedBooksLanguage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectPublished(canvasElement: HTMLElement, persona: Persona, locale: Locale) {
  const canvas = within(canvasElement);
  const text = textOf(sample(persona, 'reading-page-selection').answer);
  const copy = messages[locale];
  await expect(canvas.findByRole('heading', {
    name: headerTitle(sample(persona, 'reading-page-header').answer),
  })).resolves.toBeVisible();
  await expect(canvas.getByRole('article')).toHaveAttribute('lang', text.language);
  await expect(canvas.getByRole('article')).toHaveAttribute('dir', 'auto');
  await expect(canvas.findByText(text.body)).resolves.toBeVisible();
  await expect(canvas.getByText(text.language)).toBeVisible();
  await expect(canvas.getByText(copy.language)).toBeVisible();
  const name = languageName(text.language, locale);
  if (name !== text.language) await expect(canvas.getByText(name)).toBeVisible();
  const credits = sample(persona, 'reading-page-agent-credits').answer as AgentCreditPage;
  const authors = credits.items.filter(credit => credit.role === 'author');
  await expect(authors.length).toBeGreaterThan(0);
  for (const author of authors) {
    await expect(canvas.getByRole('link', { name: author.displayName })).toHaveAttribute('href',
      `/${locale}${authorHref({ kind: 'agent', handle: author.handle, agent: author.agent })}`);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  if (persona === 'visitor') {
    await expect(canvasElement.querySelector('[data-reader-settings="device"]')).toBeTruthy();
    return;
  }
  await waitFor(() => expect(canvasElement.querySelector('[data-reader-settings="account"]')).toBeTruthy());
  await expect(canvas.getByRole('button', { name: copy.settings })).toBeVisible();
}

function published(persona: Persona, locale: Locale, viewport: 'desktop' | 'phone'): Story {
  return {
    args: { request: { persona, locale, kind: 'published' } },
    globals: { locale, viewport: { value: viewport } },
    play({ canvasElement }) {
      return expectPublished(canvasElement, persona, locale);
    },
  };
}

export const VisitorEnglishDesktop: Story = published('visitor', 'en', 'desktop');
export const VisitorEnglishPhone: Story = published('visitor', 'en', 'phone');
export const VisitorTraditionalChineseDesktop: Story = published('visitor', 'zh-Hant', 'desktop');
export const VisitorTraditionalChinesePhone: Story = published('visitor', 'zh-Hant', 'phone');
export const MemberEnglishDesktop: Story = published('member', 'en', 'desktop');
export const MemberEnglishPhone: Story = published('member', 'en', 'phone');
export const MemberTraditionalChineseDesktop: Story = published('member', 'zh-Hant', 'desktop');
export const MemberTraditionalChinesePhone: Story = published('member', 'zh-Hant', 'phone');
export const StrangerEnglishDesktop: Story = published('stranger', 'en', 'desktop');
export const OwnerEnglishDesktop: Story = published('owner', 'en', 'desktop');
export const ModeratorEnglishDesktop: Story = published('moderator', 'en', 'desktop');
export const OperatorEnglishDesktop: Story = published('operator', 'en', 'desktop');
export const VisitorSimplifiedChineseDesktop: Story = published('visitor', 'zh-Hans', 'desktop');
export const VisitorJapaneseDesktop: Story = published('visitor', 'ja', 'desktop');
export const VisitorJapanesePhone: Story = published('visitor', 'ja', 'phone');
export const VisitorKoreanDesktop: Story = published('visitor', 'ko', 'desktop');
export const VisitorGermanDesktop: Story = published('visitor', 'de', 'desktop');
export const VisitorFrenchDesktop: Story = published('visitor', 'fr', 'desktop');
export const VisitorSpanishDesktop: Story = published('visitor', 'es', 'desktop');

export const MemberLoading: Story = {
  args: { request: { persona: 'member', locale: 'en', kind: 'published', hold: true } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const text = textOf(sample('member', 'reading-page-selection').answer);
    await expect(canvas.getByRole('status')).toHaveTextContent(messages.en.loading);
    await expect(canvas.queryByText(text.body)).toBeNull();
    await expect(canvas.queryByRole('heading', {
      name: headerTitle(sample('member', 'reading-page-header').answer),
    })).toBeNull();
  },
};
export const MemberLoadingPhone: Story = { ...MemberLoading, globals: { viewport: { value: 'phone' } } };

const privateRef = recordedId(sample('owner', 'private-reading-page-header').path);

function privateText(viewport: 'desktop' | 'phone'): Story {
  return {
    args: { request: { persona: 'owner', locale: 'en', kind: 'private' } },
    globals: { locale: 'en', viewport: { value: viewport } },
    parameters: { route: { pathname: textHref(privateRef) } },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      const title = problemTitle(sample('owner', 'private-reading-page-selection').answer);
      const text = textOf(sample('owner', 'reading-page-selection').answer);
      await expect(canvas.findByRole('alert')).resolves.toBeVisible();
      await expect(canvas.getByRole('heading', { name: title })).toBeVisible();
      await expect(canvas.queryByText(text.body)).toBeNull();
      await expect(canvas.queryByRole('heading', { name: messages.en.textNotFoundTitle })).toBeNull();
      await expect(canvasElement.querySelector('[data-reader-settings]')).toBeNull();
    },
  };
}

export const OwnerPrivateTextDesktop: Story = privateText('desktop');
export const OwnerPrivateTextPhone: Story = privateText('phone');

function privateHeader(persona: Exclude<Persona, 'owner'>, viewport: 'desktop' | 'phone'): Story {
  return {
    args: { request: { persona, locale: 'en', kind: 'private' } },
    globals: { locale: 'en', viewport: { value: viewport } },
    parameters: { route: { pathname: textHref(privateRef) } },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      const refused = problemTitle(sample(persona, 'private-reading-page-header').answer);
      await expect(canvas.findByRole('heading', { name: messages.en.notFoundTitle })).resolves.toBeVisible();
      await expect(canvas.getByText(messages.en.notFoundBody)).toBeVisible();
      await expect(canvas.queryByRole('heading', { name: refused })).toBeNull();
      await expect(canvas.queryByText(textOf(sample(persona, 'reading-page-selection').answer).body)).toBeNull();
    },
  };
}

export const VisitorPrivateWorkDesktop: Story = privateHeader('visitor', 'desktop');
export const VisitorPrivateWorkPhone: Story = privateHeader('visitor', 'phone');
export const StrangerPrivateWorkDesktop: Story = privateHeader('stranger', 'desktop');
export const MemberPrivateWorkDesktop: Story = privateHeader('member', 'desktop');
export const ModeratorPrivateWorkDesktop: Story = privateHeader('moderator', 'desktop');
export const OperatorPrivateWorkDesktop: Story = privateHeader('operator', 'desktop');
