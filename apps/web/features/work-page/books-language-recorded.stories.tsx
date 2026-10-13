import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { BooksLanguageRecordedView } from './books-language-recorded-page.tsx';
import {
  booksLanguageReading,
  booksLanguageReads,
  type BooksLanguageReading,
} from './books-language-recorded-page.ts';
import { messages } from './messages.ts';
import { defaultReaderSettings } from './reader-settings.ts';
import { textHref } from './route.ts';

const record = books as AnswerRecord;

type MemberRequest =
  | { kind: 'selected'; hold?: boolean }
  | { kind: 'missing-language' };

function recordedSample(label: string): AnswerSample {
  const found = record.personas.member.find((item) => item.label === label);
  if (!found) throw new Error(`Missing recorded sample member/${label}`);
  return found;
}

function recordedId(path: string): string {
  const id = new URL(path, 'https://recorded.invalid').pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  )?.[0];
  if (!id) throw new Error(`Recorded path has no id: ${path}`);
  return id;
}

function requireQuery(path: string, key: string): string {
  const value = new URL(path, 'https://recorded.invalid').searchParams.get(key);
  if (!value) throw new Error(`Recorded path has no ${key}: ${path}`);
  return value;
}

function textOf(value: unknown): { language: string; body: string } {
  if (!value || typeof value !== 'object') throw new Error('Recorded selection is empty');
  const text = value as { language?: unknown; body?: unknown };
  if (typeof text.language !== 'string' || typeof text.body !== 'string')
    throw new Error('Recorded selection has no text');
  return { language: text.language, body: text.body };
}

function headerTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value) || !value.title)
    throw new Error('Recorded header has no title');
  const title = (value.title as { value?: unknown }).value;
  if (typeof title !== 'string') throw new Error('Recorded header title is empty');
  return title;
}

function authorOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items))
    throw new Error('Recorded credits have no author');
  const agent = (value.items[0] as { agent?: unknown } | undefined)?.agent;
  if (typeof agent !== 'string') throw new Error('Recorded author has no agent');
  return agent;
}

function problemTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { title?: unknown }).title !== 'string')
    throw new Error('Recorded problem has no title');
  return (value as { title: string }).title;
}

function selectionsFor(request: MemberRequest): RecordedSelection[] {
  if (request.kind === 'missing-language') {
    return [
      { label: 'work-header', state: 'populated' },
      { label: 'missing-selected-language', state: 'error' },
    ];
  }
  const state = request.hold ? 'loading' : 'populated';
  return [
    { label: 'work-header', state },
    { label: 'selected-swedish-text', state },
    { label: 'credits-en', state },
  ];
}

async function loadMember(main: MainClient, request: MemberRequest): Promise<BooksLanguageReading> {
  const header = recordedSample('work-header');
  const actingSubject = requireQuery(header.path, 'actingSubject');
  const reads = booksLanguageReads({ main, actingSubject });
  const work = await reads.readWorkHeader(recordedId(header.path));
  if (!work.ok) return booksLanguageReading({ text: work });
  if (request.kind === 'missing-language') {
    const refused = recordedSample('missing-selected-language');
    const text = await reads.readText(work.data.mainVersion, requireQuery(refused.path, 'language'));
    return booksLanguageReading({ text, header: work.data });
  }
  const credits = recordedSample('credits-en');
  const text = await reads.readText(work.data.mainVersion, work.data.selectedLanguage ?? undefined);
  const creditPage = text.ok
    ? await reads.readCredits(work.data.id, requireQuery(credits.path, 'language'))
    : null;
  return booksLanguageReading({ text, credits: creditPage, header: work.data });
}

function RecordedBooksLanguage({ request }: { request: MemberRequest }) {
  const [reading, setReading] = useState<BooksLanguageReading | { kind: 'loading' }>({
    kind: 'loading',
  });
  const key = JSON.stringify(request);
  useEffect(() => {
    const current = JSON.parse(key) as MemberRequest;
    const replay = recordedFetch(record, 'member', selectionsFor(current), { pathPrefix: BFF_PREFIX });
    const main = browserMainApi(window.location.origin, { anonymous: true, fetcher: replay.fetcher });
    let mounted = true;
    void loadMember(main, current)
      .then((next) => {
        if (mounted) setReading(next);
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
  return (
    <BooksLanguageRecordedView
      reading={reading}
      workRef={recordedId(recordedSample('work-header').path)}
      settings={defaultReaderSettings}
      actingSubject={null}
      locale="en"
      messages={messages.en}
    />
  );
}

const meta = {
  title: 'Work page/Recorded content language',
  component: RecordedBooksLanguage,
  args: { request: { kind: 'selected' } },
  parameters: {
    controls: { disable: true },
    route: { pathname: textHref(recordedId(recordedSample('work-header').path)) },
  },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedBooksLanguage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectSelected(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const text = textOf(recordedSample('selected-swedish-text').answer);
  const agent = authorOf(recordedSample('credits-en').answer);
  await expect(
    canvas.findByRole('heading', { name: headerTitle(recordedSample('work-header').answer) }),
  ).resolves.toBeVisible();
  await expect(canvas.getByRole('article')).toHaveAttribute('lang', text.language);
  await expect(canvas.getByText(text.body)).toBeVisible();
  await expect(canvas.getByText(text.language)).toBeVisible();
  await expect(canvas.getByText(messages.en.language)).toBeVisible();
  await expect(canvas.getByText(messages.en.author)).toBeVisible();
  await expect(canvas.getByRole('link', { name: agent })).toBeVisible();
}

export const MemberSelectedLanguageDesktop: Story = {
  play({ canvasElement }) {
    return expectSelected(canvasElement);
  },
};

export const MemberSelectedLanguagePhone: Story = {
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: MemberSelectedLanguageDesktop.play,
};

export const MemberLoading: Story = {
  args: { request: { kind: 'selected', hold: true } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const text = textOf(recordedSample('selected-swedish-text').answer);
    await expect(canvas.getByRole('status')).toHaveTextContent(messages.en.loading);
    await expect(canvas.queryByText(text.body)).toBeNull();
    await expect(
      canvas.queryByRole('heading', { name: headerTitle(recordedSample('work-header').answer) }),
    ).toBeNull();
  },
};

export const MemberMissingLanguageDesktop: Story = {
  args: { request: { kind: 'missing-language' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const title = problemTitle(recordedSample('missing-selected-language').answer);
    const text = textOf(recordedSample('selected-swedish-text').answer);
    await expect(canvas.findByRole('alert')).resolves.toBeVisible();
    await expect(canvas.getByRole('heading', { name: title })).toBeVisible();
    await expect(canvas.queryByText(text.body)).toBeNull();
    await expect(canvas.queryByRole('heading', { name: messages.en.textNotFoundTitle })).toBeNull();
  },
};

export const MemberMissingLanguagePhone: Story = {
  args: MemberMissingLanguageDesktop.args,
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: MemberMissingLanguageDesktop.play,
};
