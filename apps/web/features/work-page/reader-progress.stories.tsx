import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText } from '@rezics/document';
import { useLayoutEffect, useState } from 'react';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { WebRatedContentProvider } from '../document-editor/rated-content.tsx';
import type { ContentRatings } from '../api/content-rating.ts';
import { ChapterReader } from './reader.tsx';
import reader from './reader.stories.tsx';
import type { ChapterRead, Progress } from './types.ts';
import { chapterHref } from './route.ts';
import * as fixture from './fixtures.ts';

const initialProgress: Progress = { structure: fixture.chapter.composition, occurrence: fixture.chapter.occurrence,
  selectedRevision: fixture.chapter.selectedRevision, completed: false, position: null, version: 0 };
const meta = { ...reader, title: 'Work page/Reader progress', component: ChapterReader,
  args: { ...reader.args, progress: { ok: true, data: initialProgress } },
} satisfies Meta<typeof ChapterReader>;
export default meta;
type Story = StoryObj<typeof meta>;

interface Command {
  actingSubject: string; selectedRevision: string; expectedVersion: number;
  completed: boolean; position: string | null;
}
interface Write { occurrence: string; command: Command; keepalive: boolean | undefined; key: string | null }
let writes: Write[];
let reads: URL[];
let reply: (write: Write) => Promise<Response>;
let release: () => void;

function saved(write: Write) {
  return Response.json({ structure: fixture.chapter.composition, occurrence: write.occurrence,
    selectedRevision: write.command.selectedRevision, completed: write.command.completed,
    position: write.command.position, version: write.command.expectedVersion + 1 });
}

function recordProgress() {
  writes = []; reads = []; release = () => {};
  reply = async write => saved(write);
  window.scrollTo(0, 0);
  const original = window.fetch.bind(window);
  const mock = spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const occurrence = url.pathname.match(/\/occurrences\/([^/]+)\/progress$/)?.[1];
    if (!occurrence) return original(input, init);
    if ((init?.method ?? 'GET') === 'GET') {
      reads.push(url);
      return Response.json({ ...initialProgress, version: 8, completed: true, position: 'p:3' });
    }
    const write = { occurrence: `https://rezics.com/id/${occurrence}`,
      command: JSON.parse(String(init?.body)) as Command, keepalive: init?.keepalive,
      key: new Headers(init?.headers).get('idempotency-key') };
    writes.push(write);
    return reply(write);
  });
  return () => { release(); mock.mockRestore(); };
}

export const OpenedParagraph: Story = {
  beforeEach: recordProgress,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(writes).toHaveLength(1));
    await expect(writes[0]).toMatchObject({ occurrence: fixture.chapter.occurrence, keepalive: true,
      command: { actingSubject: reader.args.actingSubject, selectedRevision: fixture.chapter.selectedRevision,
        expectedVersion: 0, completed: false, position: 'p:0' } });
    await expect(writes[0]!.key).toMatch(/^[\da-f-]{36}$/);
    await expect(canvas.getByRole('article')).toHaveAttribute('data-content-revision', fixture.chapter.content.reference.revisionId);
    await expect(canvas.getByRole('button', { name: 'Mark chapter as read' })).toBeEnabled();
    await expect(canvas.queryByText('Chapter read')).toBeNull();
  },
};

export const CompletedChapterRemainsCompleted: Story = {
  args: { progress: { ok: true, data: { ...initialProgress, completed: true, version: 3 } } },
  beforeEach: recordProgress,
  async play({ canvasElement }) {
    await waitFor(() => expect(writes).toHaveLength(1));
    await expect(writes[0]!.command).toMatchObject({ completed: true, position: 'p:0',
      expectedVersion: 3 });
    await expect(within(canvasElement).getByText('Chapter read')).toBeVisible();
    await expect(within(canvasElement).getByRole('button', { name: 'Mark as unread' })).toBeEnabled();
  },
};

export const ConcurrentCompletionIsPreserved: Story = {
  beforeEach() {
    const cleanup = recordProgress();
    reply = async write => writes.length === 1
      ? Response.json({ code: 'stale_progress' }, { status: 409 }) : saved(write);
    return cleanup;
  },
  async play({ canvasElement }) {
    await waitFor(() => expect(writes).toHaveLength(2));
    await expect(reads).toHaveLength(1);
    await expect(reads[0]!.searchParams.get('actingSubject')).toBe(reader.args.actingSubject);
    await expect(reads[0]!.searchParams.get('selectedRevision')).toBe(fixture.chapter.selectedRevision);
    await expect(writes[1]!.command).toMatchObject({ expectedVersion: 8, completed: true, position: 'p:0' });
    await expect(writes[1]!.key).not.toBe(writes[0]!.key);
    await expect(await within(canvasElement).findByText('Chapter read')).toBeVisible();
  },
};

export const OpeningSaveFailure: Story = {
  beforeEach() {
    const cleanup = recordProgress();
    reply = async () => Response.json({ code: 'progress_denied' }, { status: 403 });
    return cleanup;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(reader.args.messages.progressFailed)).toBeVisible();
    await expect(writes).toHaveLength(1);
    await expect(reads).toHaveLength(0);
    await expect(canvas.getByRole('button', { name: 'Mark chapter as read' })).toBeEnabled();
    await expect(canvas.queryByText('Chapter read')).toBeNull();
  },
};

export const OpeningSaveFailurePhone: Story = { ...OpeningSaveFailure,
  globals: { locale: 'en', viewport: { value: 'phone' } } };

export const ConflictRetryIsBounded: Story = {
  beforeEach() {
    const cleanup = recordProgress();
    reply = async () => Response.json({ code: 'stale_progress' }, { status: 409 });
    return cleanup;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(reader.args.messages.progressFailed)).toBeVisible();
    await expect(writes).toHaveLength(2);
    await expect(reads).toHaveLength(1);
    await expect(canvas.queryByText('Chapter read')).toBeNull();
  },
};

const nextChapter: ChapterRead = { ...fixture.chapter,
  occurrence: fixture.chapter.next!, previous: fixture.chapter.occurrence, next: null,
  selectedRevision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000004',
  progress: { ...fixture.chapter.progress, occurrence: fixture.chapter.next!,
    selectedRevision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000004' },
  label: { value: 'The Next Survey', language: 'en' },
  content: { ...fixture.chapter.content,
    reference: { ...fixture.chapter.content.reference,
      revisionId: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000004' },
    body: { document: fromPlainText('The next survey starts here.\nThe map belongs to this chapter.') } },
};
const longChapter: ChapterRead = { ...fixture.chapter, content: { ...fixture.chapter.content,
  body: { document: fromPlainText(Array.from({ length: 4 }, (_, i) =>
    `Survey paragraph ${i}. ${'She measured the shore and recorded the tide. '.repeat(50)}`).join('\n')) } } };

function NavigationReader(args: React.ComponentProps<typeof ChapterReader>) {
  const [next, setNext] = useState(false);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, [next]);
  const chapter = next ? nextChapter : longChapter;
  const progress: Progress = { structure: chapter.composition, occurrence: chapter.occurrence,
    selectedRevision: chapter.selectedRevision, completed: false, position: null, version: next ? 7 : 0 };
  return <StoryRouteContext value={{ pathname: chapterHref(fixture.workRef, chapter.occurrence.slice(-36)),
    onPush: () => setNext(true) }}>
    <ChapterReader {...args} chapter={chapter} progress={{ ok: true, data: progress }} />
  </StoryRouteContext>;
}

export const NavigationKeepsCapturedChapterPosition: Story = {
  render: args => <NavigationReader {...args} />,
  beforeEach() {
    const cleanup = recordProgress();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    release = finish;
    reply = async write => { if (writes.length === 1) await held; return saved(write); };
    return cleanup;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(writes).toHaveLength(1));
    const paragraph = canvasElement.querySelector<HTMLElement>('[data-paragraph="2"]')!;
    window.scrollTo(0, window.scrollY + paragraph.getBoundingClientRect().top - 96);
    // Native scroll delivery precedes navigation; the two-second save is still pending.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await userEvent.keyboard('{ArrowRight}');
    await expect(await canvas.findByRole('heading', { name: 'The Next Survey' })).toBeVisible();
    await expect(writes).toHaveLength(1);
    release();
    await waitFor(() => expect(writes).toHaveLength(3));
    await expect(writes.map(write => [write.occurrence, write.command.position, write.command.expectedVersion]))
      .toEqual([[fixture.chapter.occurrence, 'p:0', 0], [fixture.chapter.occurrence, 'p:2', 1],
        [nextChapter.occurrence, 'p:0', 7]]);
    await expect(writes.map(write => write.command.selectedRevision))
      .toEqual([fixture.chapter.selectedRevision, fixture.chapter.selectedRevision, nextChapter.selectedRevision]);
    await expect(writes.every(write => !write.command.completed)).toBe(true);
    await expect(canvas.getByRole('button', { name: 'Mark chapter as read' })).toBeEnabled();
  },
};

export const FailedOldChapterDoesNotBlockNextChapter: Story = {
  render: args => <NavigationReader {...args} />,
  beforeEach() {
    const cleanup = recordProgress();
    reply = async write => {
      if (write.occurrence === fixture.chapter.occurrence) throw new TypeError('Connection lost');
      return saved(write);
    };
    return cleanup;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(reader.args.messages.progressFailed)).toBeVisible();
    await userEvent.keyboard('{ArrowRight}');
    await expect(await canvas.findByRole('heading', { name: 'The Next Survey' })).toBeVisible();
    await waitFor(() => expect(writes).toHaveLength(2));
    await expect(writes[1]).toMatchObject({ occurrence: nextChapter.occurrence,
      command: { expectedVersion: 7, position: 'p:0', completed: false, selectedRevision: nextChapter.selectedRevision } });
    await expect(canvas.queryByText(reader.args.messages.progressFailed)).toBeNull();
  },
};

let reveal: (ratings: ContentRatings) => void;
let ratingRead: Promise<ContentRatings>;
export const OnlyReadableTextRecordsAnOpening: Story = {
  beforeEach() {
    const cleanup = recordProgress();
    ratingRead = new Promise(resolve => { reveal = resolve; });
    return cleanup;
  },
  render: args => <WebRatedContentProvider locale="en"
    viewer={{ ready: true, signedIn: true, age: 'adult', nsfwDisplay: 'show',
      optIns: { general: true, r15: true, sexual: true, grotesque: true } }} resolve={() => ratingRead}>
    <ChapterReader {...args} />
  </WebRatedContentProvider>,
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[data-reader-text]')).toBeNull();
    await expect(writes).toHaveLength(0);
    reveal({ [fixture.chapter.content.reference.resourceId]: { status: 'assessed', labels: [] } });
    await waitFor(() => expect(writes).toHaveLength(1));
    await expect(canvasElement.querySelector('[data-reader-text]')).toBeVisible();
    await expect(writes[0]!.command).toMatchObject({ completed: false, position: 'p:0' });
  },
};
