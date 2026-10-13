import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import inventoryRecord from '../../../../tests/qa/fixtures/outcomes/books/navigate-a-thousand-chapter-inventory-thousand-chapters.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { PageContainer } from '../shell/page.tsx';
import { localizedPath } from '../../i18n/locale.ts';
import {
  BooksContentsRecordedPage, booksContentsInventoryQueryFromPath, mapBooksContentsRecordedPage,
  type BooksContentsRecordedView,
} from './books-contents-recorded-page.tsx';
import { messages } from './messages.ts';
import { chapterHref, idOf, workHref } from './route.ts';

const record = inventoryRecord as unknown as AnswerRecord;

type ChapterAnswer = {
  work: string;
  items: { occurrence: string; labels?: { value: string }[] }[];
  complete: boolean;
  nextCursor: string | null;
  count: { value: number; total: null };
};

function recordedSample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function RecordedBooksContents({ persona, label, state, headerLabel }: {
  persona: AnswerPersona;
  label: string;
  state: RecordedSelection['state'];
  headerLabel?: string;
}) {
  const [view, setView] = useState<BooksContentsRecordedView>({ kind: 'loading' });
  useEffect(() => {
    const selections: RecordedSelection[] = [
      { label, state },
      ...(headerLabel ? [{ label: headerLabel, state: 'populated' as const }] : []),
    ];
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    let mounted = true;
    const sample = recordedSample(persona, label);
    const { work, query } = booksContentsInventoryQueryFromPath(sample.path);
    const api = browserMainApi(window.location.origin, { anonymous: true, fetcher: replay.fetcher });
    const inventory = api.v1['reading-positions']({ work }).get({ query });
    const header = headerLabel ? api.v1.works({ id: work }).get({
      query: { actingSubject: typeof query.actingSubject === 'string' ? query.actingSubject : undefined },
    }) : null;
    void Promise.all([inventory, header]).then(([answer, headerAnswer]) => {
      if (!mounted) return;
      if (!answer.response && answer.error) throw answer.error.value;
      if (headerAnswer && !headerAnswer.response && headerAnswer.error) throw headerAnswer.error.value;
      setView(mapBooksContentsRecordedPage(answer, {
        workRef: work,
        workIri: sample.answer && typeof sample.answer === 'object' && 'work' in sample.answer
          && typeof sample.answer.work === 'string' ? sample.answer.work : `https://rezics.com/id/${work}`,
        locale: 'en',
        language: typeof query.language === 'string' ? query.language : undefined,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        title: headerAnswer?.data?.title ?? null,
      }));
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, label, state, headerLabel]);
  return <PageContainer>
    <BooksContentsRecordedPage view={view} locale="en" messages={messages.en} />
  </PageContainer>;
}

const meta = {
  title: 'Work page/Books contents recorded',
  component: RecordedBooksContents,
  args: { persona: 'visitor' as const, label: 'inventory-page-1', state: 'populated' as const },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecordedBooksContents>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { viewport: { value: 'phone' } } as const;
const desktop = { viewport: { value: 'desktop' } } as const;

function pageAnswer(persona: AnswerPersona, label: string): ChapterAnswer {
  return recordedSample(persona, label).answer as ChapterAnswer;
}

async function expectPage(canvasElement: HTMLElement, persona: AnswerPersona, label: string, phoneWidth: boolean) {
  const canvas = within(canvasElement);
  const answer = pageAnswer(persona, label);
  const region = canvas.getByRole('region', { name: 'Contents' });
  const first = answer.items[0]!;
  const last = answer.items.at(-1)!;
  const firstLabel = first.labels?.[0]?.value ?? '';
  const lastLabel = last.labels?.[0]?.value ?? '';
  await expect(canvas.findByText(firstLabel, { exact: true })).resolves.toBeVisible();
  await expect(within(region).getByText(`${answer.count.value} on this page`)).toBeVisible();
  await expect(within(region).getAllByRole('listitem')).toHaveLength(answer.items.length);
  await expect(within(region).getByText(lastLabel, { exact: true })).toBeVisible();
  const work = answer.work.slice(-36);
  const language = 'en';
  const firstLink = within(region).getByRole('link', { name: name => name.trim() === firstLabel });
  await expect(firstLink).toHaveAttribute('href', localizedPath(chapterHref(work, idOf(first.occurrence) ?? '', language), 'en'));
  if (answer.nextCursor) {
    await expect(within(region).getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      localizedPath(workHref(work, 'contents', null, { language, cursor: answer.nextCursor }), 'en'));
  } else {
    expect(within(region).queryByRole('link', { name: 'Next page' })).toBeNull();
  }
  expect(answer.count.total).toBeNull();
  expect(answer.complete).toBe(answer.nextCursor === null);
  if (phoneWidth) expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

function populatedPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => { await expectPage(canvasElement, 'visitor', 'inventory-page-1', phoneWidth); };
}

function continuedPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    await expectPage(canvasElement, 'visitor', 'inventory-page-10', phoneWidth);
    await expect(within(canvasElement).getByRole('link', { name: 'First page' })).toBeVisible();
  };
}

function completePlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => { await expectPage(canvasElement, 'visitor', 'inventory-page-18', phoneWidth); };
}

function refusalPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const problem = recordedSample('visitor', 'inventory-page-2').answer as { title: string };
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent(problem.title);
    await expect(within(alert).getByRole('link', { name: 'First page' })).toBeVisible();
    expect(canvas.queryByRole('list')).toBeNull();
    if (phoneWidth) expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  };
}

function loadingPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Loading…' })).toBeVisible();
    expect(canvas.queryByRole('list')).toBeNull();
    expect(canvas.queryByRole('alert')).toBeNull();
    if (phoneWidth) expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  };
}

function memberPlay(phoneWidth: boolean): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const title = (recordedSample('member', 'work-header').answer as { title: { value: string } }).title.value;
    await expect(within(canvasElement).findByText(title)).resolves.toBeVisible();
    await expectPage(canvasElement, 'member', 'inventory-page-1', phoneWidth);
  };
}

export const VisitorLoadingPhone: Story = {
  args: { state: 'loading' }, globals: phone, play: loadingPlay(true),
};
export const VisitorLoadingDesktop: Story = {
  args: { state: 'loading' }, globals: desktop, play: loadingPlay(false),
};
export const VisitorPopulatedPhone: Story = { globals: phone, play: populatedPlay(true) };
export const VisitorPopulatedDesktop: Story = { globals: desktop, play: populatedPlay(false) };
export const VisitorContinuedPhone: Story = {
  args: { label: 'inventory-page-10' }, globals: phone, play: continuedPlay(true),
};
export const VisitorContinuedDesktop: Story = {
  args: { label: 'inventory-page-10' }, globals: desktop, play: continuedPlay(false),
};
export const VisitorCompletePhone: Story = {
  args: { label: 'inventory-page-18' }, globals: phone, play: completePlay(true),
};
export const VisitorCompleteDesktop: Story = {
  args: { label: 'inventory-page-18' }, globals: desktop, play: completePlay(false),
};
export const VisitorRefusalPhone: Story = {
  args: { label: 'inventory-page-2', state: 'error' }, globals: phone, play: refusalPlay(true),
};
export const VisitorRefusalDesktop: Story = {
  args: { label: 'inventory-page-2', state: 'error' }, globals: desktop, play: refusalPlay(false),
};
export const MemberPopulatedPhone: Story = {
  args: { persona: 'member', headerLabel: 'work-header' }, globals: phone, play: memberPlay(true),
};
export const MemberPopulatedDesktop: Story = {
  args: { persona: 'member', headerLabel: 'work-header' }, globals: desktop, play: memberPlay(false),
};
