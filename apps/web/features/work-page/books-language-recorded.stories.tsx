import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type {
  AnswerPersona,
  AnswerRecord,
  AnswerSample,
} from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/read-non-ui-languages-non-ui-languages.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import {
  recordedFetch,
  type RecordedSelection,
  type RecordedState,
} from '../stories/recorded-fetch.ts';
import { BooksLanguageRecordedView } from './books-language-recorded-page.tsx';
import {
  fetchBooksLanguageMetadata,
  fetchBooksLanguageSelection,
  fetchMemberBooksLanguage,
  fetchPublishedBooksLanguage,
  type BooksLanguageReading,
} from './books-language-recorded-page.ts';
import { messages } from './messages.ts';
import { defaultReaderSettings } from './reader-settings.ts';
import { textHref } from './route.ts';

const record = books as AnswerRecord;

type ReadingRequest =
  | { kind: 'published'; metadata: string; text: string; credits: string; hold?: boolean }
  | { kind: 'member'; header: string; text: string; credits: string }
  | { kind: 'selection'; label: string }
  | { kind: 'metadata'; label: string; state: 'error' | 'empty' };

type ReadingArgs = { persona: AnswerPersona; locale: UiLocale; request: ReadingRequest };

function recordedSample(persona: AnswerPersona, label: string): AnswerSample {
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

function recordedQuery(path: string): URLSearchParams {
  return new URL(path, 'https://recorded.invalid').searchParams;
}

function requireQuery(path: string, key: string): string {
  const value = recordedQuery(path).get(key);
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

function titleOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('originalTitle' in value) || !value.originalTitle) {
    throw new Error('Recorded metadata has no title');
  }
  const title = (value.originalTitle as { value?: unknown }).value;
  if (typeof title !== 'string') throw new Error('Recorded title is empty');
  return title;
}

function headerTitle(value: unknown): string {
  if (!value || typeof value !== 'object' || !('title' in value) || !value.title)
    throw new Error('Recorded header has no title');
  const title = (value.title as { value?: unknown }).value;
  if (typeof title !== 'string') throw new Error('Recorded header title is empty');
  return title;
}

function authorOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) {
    throw new Error('Recorded credits have no author');
  }
  const agent = (value.items[0] as { agent?: unknown } | undefined)?.agent;
  if (typeof agent !== 'string') throw new Error('Recorded author has no agent');
  return agent;
}

function problemTitle(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !('title' in value) ||
    typeof value.title !== 'string'
  ) {
    throw new Error('Recorded problem has no title');
  }
  return value.title;
}

function workOf(value: unknown): string {
  if (!value || typeof value !== 'object' || !('work' in value) || typeof value.work !== 'string') {
    throw new Error('Recorded metadata has no work');
  }
  return value.work;
}

function selectionsFor(args: ReadingArgs): RecordedSelection[] {
  const state = (
    args.request.kind === 'published' && args.request.hold ? 'loading' : 'populated'
  ) as RecordedState;
  if (args.request.kind === 'published')
    return [
      { label: args.request.metadata, state },
      { label: args.request.text, state },
      { label: args.request.credits, state },
    ];
  if (args.request.kind === 'member')
    return [
      { label: args.request.header, state: 'populated' },
      { label: args.request.text, state: 'populated' },
      { label: args.request.credits, state: 'populated' },
    ];
  if (args.request.kind === 'selection') return [{ label: args.request.label, state: 'error' }];
  return [{ label: args.request.label, state: args.request.state }];
}

function workRefFor(args: ReadingArgs): string {
  if (args.request.kind === 'published')
    return recordedId(recordedSample(args.persona, args.request.metadata).path);
  if (args.request.kind === 'member')
    return recordedId(recordedSample(args.persona, args.request.header).path);
  return recordedId(recordedSample(args.persona, args.request.label).path);
}

async function loadReading(main: MainClient, args: ReadingArgs): Promise<BooksLanguageReading> {
  if (args.request.kind === 'published') {
    const metadata = recordedSample(args.persona, args.request.metadata);
    const text = recordedSample(args.persona, args.request.text);
    const acting = recordedQuery(metadata.path).get('actingSubject') ?? undefined;
    return fetchPublishedBooksLanguage(main, {
      workId: recordedId(metadata.path),
      mainVersionId: recordedId(text.path),
      presentationLanguage: requireQuery(metadata.path, 'language'),
      ...(recordedQuery(text.path).get('language')
        ? { selectionLanguage: requireQuery(text.path, 'language') }
        : {}),
      ...(acting ? { actingSubject: acting } : {}),
    });
  }
  if (args.request.kind === 'member') {
    const header = recordedSample(args.persona, args.request.header);
    const credits = recordedSample(args.persona, args.request.credits);
    return fetchMemberBooksLanguage(main, {
      workId: recordedId(header.path),
      actingSubject: requireQuery(header.path, 'actingSubject'),
      presentationLanguage: requireQuery(credits.path, 'language'),
    });
  }
  if (args.request.kind === 'selection') {
    const refused = recordedSample(args.persona, args.request.label);
    return fetchBooksLanguageSelection(
      main,
      recordedId(refused.path),
      requireQuery(refused.path, 'language'),
    );
  }
  const details = recordedSample(args.persona, args.request.label);
  const acting = recordedQuery(details.path).get('actingSubject') ?? undefined;
  return fetchBooksLanguageMetadata(
    main,
    recordedId(details.path),
    requireQuery(details.path, 'language'),
    acting,
  );
}

function RecordedBooksLanguage(args: ReadingArgs) {
  const [reading, setReading] = useState<BooksLanguageReading | { kind: 'loading' }>({
    kind: 'loading',
  });
  const key = JSON.stringify(args);
  useEffect(() => {
    const current = JSON.parse(key) as ReadingArgs;
    const replay = recordedFetch(record, current.persona, selectionsFor(current), {
      pathPrefix: BFF_PREFIX,
    });
    const main = browserMainApi(window.location.origin, {
      anonymous: true,
      fetcher: replay.fetcher,
    });
    let mounted = true;
    void loadReading(main, current)
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
      workRef={workRefFor(args)}
      settings={defaultReaderSettings}
      actingSubject={null}
      locale={args.locale}
      messages={messages[args.locale]}
    />
  );
}

const publishedWork = recordedId(recordedSample('visitor', 'metadata-en').path);
const visitorPublished: ReadingRequest = {
  kind: 'published',
  metadata: 'metadata-en',
  text: 'selected-text-en',
  credits: 'credits-en',
};

const meta = {
  title: 'Work page/Recorded content language',
  component: RecordedBooksLanguage,
  args: { persona: 'visitor', locale: 'en', request: visitorPublished },
  parameters: { controls: { disable: true }, route: { pathname: textHref(publishedWork) } },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedBooksLanguage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectReading(
  canvasElement: HTMLElement,
  persona: AnswerPersona,
  title: string,
  textLabel: string,
  creditsLabel: string,
) {
  const canvas = within(canvasElement);
  const text = textOf(recordedSample(persona, textLabel).answer);
  const agent = authorOf(recordedSample(persona, creditsLabel).answer);
  await expect(canvas.findByRole('heading', { name: title })).resolves.toBeVisible();
  await expect(canvas.getByRole('article')).toHaveAttribute('lang', text.language);
  await expect(canvas.getByText(text.body)).toBeVisible();
  await expect(canvas.getByText(text.language)).toBeVisible();
  await expect(canvas.getByRole('link', { name: agent })).toBeVisible();
}

export const VisitorEnglishDesktop: Story = {
  async play({ canvasElement }) {
    const title = titleOf(recordedSample('visitor', 'metadata-en').answer);
    await expectReading(canvasElement, 'visitor', title, 'selected-text-en', 'credits-en');
    await expect(within(canvasElement).getByText(messages.en.language)).toBeVisible();
    await expect(within(canvasElement).getByText(messages.en.author)).toBeVisible();
  },
};

export const VisitorEnglishPhone: Story = {
  globals: { locale: 'en', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expectReading(
      canvasElement,
      'visitor',
      titleOf(recordedSample('visitor', 'metadata-en').answer),
      'selected-text-en',
      'credits-en',
    );
  },
};

export const VisitorSwedishRequestsDesktop: Story = {
  args: {
    request: {
      kind: 'published',
      metadata: 'metadata-sv',
      text: 'selected-text-sv',
      credits: 'credits-sv',
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expectReading(
      canvasElement,
      'visitor',
      titleOf(recordedSample('visitor', 'metadata-sv').answer),
      'selected-text-sv',
      'credits-sv',
    );
    await expect(canvas.getByText(messages.en.language)).toBeVisible();
    await expect(canvas.getByText(messages.en.author)).toBeVisible();
  },
};

export const VisitorSwedishTextJapaneseDesktop: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja', viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expectReading(
      canvasElement,
      'visitor',
      titleOf(recordedSample('visitor', 'metadata-en').answer),
      'selected-text-en',
      'credits-en',
    );
    await expect(canvas.getByText(messages.ja.language)).toBeVisible();
    await expect(canvas.getByText(messages.ja.author)).toBeVisible();
    await expect(canvas.queryByText(messages.en.author)).toBeNull();
  },
};

export const VisitorSwedishTextJapanesePhone: Story = {
  args: { locale: 'ja' },
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  play: VisitorSwedishTextJapaneseDesktop.play,
};

export const VisitorLoading: Story = {
  args: { request: { ...visitorPublished, hold: true } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const text = textOf(recordedSample('visitor', 'selected-text-en').answer);
    await expect(canvas.getByRole('status')).toHaveTextContent(messages.en.loading);
    await expect(canvas.queryByText(text.body)).toBeNull();
    await expect(
      canvas.queryByRole('heading', {
        name: titleOf(recordedSample('visitor', 'metadata-en').answer),
      }),
    ).toBeNull();
  },
};

export const MemberSelectedLanguageDesktop: Story = {
  args: {
    persona: 'member',
    request: {
      kind: 'member',
      header: 'work-header',
      text: 'selected-swedish-text',
      credits: 'credits-en',
    },
  },
  async play({ canvasElement }) {
    await expectReading(
      canvasElement,
      'member',
      headerTitle(recordedSample('member', 'work-header').answer),
      'selected-swedish-text',
      'credits-en',
    );
  },
};

export const MemberSelectedLanguagePhone: Story = {
  args: MemberSelectedLanguageDesktop.args,
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: MemberSelectedLanguageDesktop.play,
};

async function expectRefusal(canvasElement: HTMLElement, persona: AnswerPersona, label: string) {
  const canvas = within(canvasElement);
  const title = problemTitle(recordedSample(persona, label).answer);
  const text = textOf(recordedSample('member', 'selected-swedish-text').answer);
  await expect(canvas.findByRole('alert')).resolves.toBeVisible();
  await expect(canvas.getByRole('heading', { name: title })).toBeVisible();
  await expect(canvas.queryByText(text.body)).toBeNull();
  await expect(canvas.queryByRole('heading', { name: messages.en.textNotFoundTitle })).toBeNull();
}

export const MemberMissingLanguageDesktop: Story = {
  args: { persona: 'member', request: { kind: 'selection', label: 'missing-selected-language' } },
  play({ canvasElement }) {
    return expectRefusal(canvasElement, 'member', 'missing-selected-language');
  },
};

export const MemberMissingLanguagePhone: Story = {
  args: MemberMissingLanguageDesktop.args,
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: MemberMissingLanguageDesktop.play,
};

export const VisitorPrivateWorkDesktop: Story = {
  args: { request: { kind: 'metadata', label: 'private-metadata', state: 'error' } },
  parameters: {
    route: { pathname: textHref(recordedId(recordedSample('visitor', 'private-metadata').path)) },
  },
  play({ canvasElement }) {
    return expectRefusal(canvasElement, 'visitor', 'private-metadata');
  },
};

export const VisitorPrivateWorkPhone: Story = {
  args: VisitorPrivateWorkDesktop.args,
  parameters: VisitorPrivateWorkDesktop.parameters,
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: VisitorPrivateWorkDesktop.play,
};

export const OwnerPrivateWorkDesktop: Story = {
  args: {
    persona: 'owner',
    request: { kind: 'metadata', label: 'private-metadata', state: 'empty' },
  },
  parameters: {
    route: { pathname: textHref(recordedId(recordedSample('owner', 'private-metadata').path)) },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const details = recordedSample('owner', 'private-metadata').answer;
    const refused = problemTitle(recordedSample('visitor', 'private-metadata').answer);
    await expect(canvas.findByRole('heading', { name: messages.en.noContents })).resolves.toBeVisible();
    await expect(canvas.getByRole('status')).toBeVisible();
    await expect(canvas.queryByText(messages.en.loading)).toBeNull();
    await expect(canvas.getByText(messages.en.noContentsBody)).toBeVisible();
    await expect(canvas.getByText(workOf(details))).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: refused })).toBeNull();
  },
};

export const OwnerPrivateWorkPhone: Story = {
  args: OwnerPrivateWorkDesktop.args,
  parameters: OwnerPrivateWorkDesktop.parameters,
  globals: { locale: 'en', viewport: { value: 'phone' } },
  play: OwnerPrivateWorkDesktop.play,
};
