import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import inventoryRecord from '../../../../tests/qa/fixtures/outcomes/anime/navigate-a-thousand-episode-inventory-thousand-chapters.json';
import { localizedPath } from '../../i18n/locale.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { booksEditionReads } from './books-edition-page.read.ts';
import {
  BooksContentsRecordedPage, readContentsInventory, type BooksContentsRecordedView,
} from './books-contents-recorded-page.tsx';
import { messages } from './messages.ts';
import { iriOf, workHref } from './route.ts';

const record = inventoryRecord as unknown as AnswerRecord;
const searchLabel = 'distant-episode-search';

type SearchAnswer = {
  work: string;
  items: unknown[];
  complete: boolean;
  nextCursor: string | null;
  count: { value: number; total: null };
};

function recordedSample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

/** The record's work and acting subject. The production reader supplies page size, language and position. */
function identityOf(path: string): { work: string; actingSubject?: string } {
  const url = new URL(path, 'https://recorded.invalid');
  const work = url.pathname.split('/').at(-1) ?? '';
  const actingSubject = url.searchParams.get('actingSubject') ?? undefined;
  return { work, ...(actingSubject ? { actingSubject } : {}) };
}

function enteredLabel(path: string): string {
  const q = new URL(path, 'https://recorded.invalid').searchParams.get('q');
  if (!q) throw new Error('recorded search has no label');
  return q;
}

function RecordedAnimeContents({ persona, state, header = false }: {
  persona: AnswerPersona;
  state: RecordedSelection['state'];
  header?: boolean;
}) {
  const [view, setView] = useState<BooksContentsRecordedView>({ kind: 'loading' });
  useEffect(() => {
    const chosen = recordedSample(persona, searchLabel);
    const { work, actingSubject } = identityOf(chosen.path);
    const withHeader = header && state !== 'loading';
    const replay = recordedFetch(record, persona, [
      ...(withHeader ? [{ label: 'work-header', state: 'populated' as const }] : []),
      { label: searchLabel, state },
    ], { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const main = browserMainApi(window.location.origin, {
      anonymous: !actingSubject, fetcher: replay.fetcher,
    });
    const host = { main, ...(actingSubject ? { actingSubject } : {}) };
    void (async () => {
      const readHeader = withHeader ? await booksEditionReads(host).readWorkHeader(work) : null;
      if (readHeader && !readHeader.ok) throw new Error(readHeader.failure);
      const next = await readContentsInventory(host, {
        workId: work, workRef: work, workIri: iriOf(work), locale: 'en', language: 'en',
        q: enteredLabel(chosen.path), title: readHeader?.ok ? readHeader.data.title : null,
      });
      if (mounted) setView(next);
    })().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, state, header]);
  return <PageContainer>
    <BooksContentsRecordedPage view={view} locale="en" messages={messages.en} />
  </PageContainer>;
}

const meta = {
  title: 'Work page/Anime contents recorded',
  component: RecordedAnimeContents,
  args: { persona: 'visitor' as const, state: 'populated' as const },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedAnimeContents>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;

function searchAnswer(persona: AnswerPersona): SearchAnswer {
  return recordedSample(persona, searchLabel).answer as SearchAnswer;
}

function searchPlay(persona: AnswerPersona, phoneWidth: boolean, titled: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answer = searchAnswer(persona);
    const q = enteredLabel(recordedSample(persona, searchLabel).path);
    const work = answer.work.slice(-36);
    await expect(canvas.findByText(`${answer.count.value} on this page`)).resolves.toBeVisible();
    const region = canvas.getByRole('region', { name: 'Contents' });
    const search = within(region).getByRole('search', { name: 'Search contents' });
    await expect(within(search).getByRole('searchbox', { name: 'Search contents' })).toHaveValue(q);
    await expect(search).toHaveAttribute('action', localizedPath(workHref(work, 'contents'), 'en'));
    await expect(search.querySelector('input[name="language"]')).toHaveAttribute('value', 'en');
    await expect(within(region).getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      localizedPath(workHref(work, 'contents', null, { language: 'en', q, cursor: answer.nextCursor ?? '' }), 'en'));
    await expect(canvas.queryByRole('heading', { name: 'Nothing to read yet' })).toBeNull();
    await expect(canvas.queryByRole('list')).toBeNull();
    await expect(answer.items).toHaveLength(0);
    await expect(answer.complete).toBe(false);
    await expect(answer.nextCursor).toBeTruthy();
    await expect(answer.count.total).toBeNull();
    if (titled) {
      const title = (recordedSample('owner', 'work-header').answer as { title: { value: string } }).title.value;
      await expect(within(region).getByText(title)).toBeVisible();
    }
    if (phoneWidth) await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  };
}

function loadingPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Loading…' })).toBeVisible();
    await expect(canvas.queryByRole('list')).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.queryByRole('search')).toBeNull();
    if (phoneWidth) await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  };
}

export const VisitorLoadingPhone: Story = {
  args: { state: 'loading' }, globals: phone, play: loadingPlay(true),
};
export const VisitorLoadingDesktop: Story = {
  args: { state: 'loading' }, globals: desktop, play: loadingPlay(false),
};
export const VisitorSearchPhone: Story = { globals: phone, play: searchPlay('visitor', true, false) };
export const VisitorSearchDesktop: Story = { globals: desktop, play: searchPlay('visitor', false, false) };
export const StrangerSearchPhone: Story = {
  args: { persona: 'stranger' }, globals: phone, play: searchPlay('stranger', true, false),
};
export const StrangerSearchDesktop: Story = {
  args: { persona: 'stranger' }, globals: desktop, play: searchPlay('stranger', false, false),
};
export const MemberSearchPhone: Story = {
  args: { persona: 'member' }, globals: phone, play: searchPlay('member', true, false),
};
export const MemberSearchDesktop: Story = {
  args: { persona: 'member' }, globals: desktop, play: searchPlay('member', false, false),
};
export const OwnerSearchPhone: Story = {
  args: { persona: 'owner', header: true }, globals: phone, play: searchPlay('owner', true, true),
};
export const OwnerSearchDesktop: Story = {
  args: { persona: 'owner', header: true }, globals: desktop, play: searchPlay('owner', false, true),
};
export const ModeratorSearchPhone: Story = {
  args: { persona: 'moderator' }, globals: phone, play: searchPlay('moderator', true, false),
};
export const ModeratorSearchDesktop: Story = {
  args: { persona: 'moderator' }, globals: desktop, play: searchPlay('moderator', false, false),
};
export const OperatorSearchPhone: Story = {
  args: { persona: 'operator' }, globals: phone, play: searchPlay('operator', true, false),
};
export const OperatorSearchDesktop: Story = {
  args: { persona: 'operator' }, globals: desktop, play: searchPlay('operator', false, false),
};
