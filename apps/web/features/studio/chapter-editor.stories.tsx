import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ChapterEditor, type ChapterEditorProps } from './chapter-editor.tsx';
import { agents, chapterOpened, ids, storyMain } from './fixtures.ts';
import { chapterMemoryKey, localDraftKey, readChapterMemory } from './local-draft.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

// A Book's chapter with an in-memory Main (fixtures.ts): Content drafts on the
// head they were typed on, a conflict that names Main's winning head, and a
// publication followed by an update. Each story makes its own Main.

const opening = '第三章 最后一班车\n末班车到站时，整座站台只有她一个人。';
const book = { id: ids.serial, title: { value: '雨夜书店', language: 'zh-Hans' } };
type Args = ChapterEditorProps & { story?: ReturnType<typeof storyMain> };

function page(options: Parameters<typeof storyMain>[0] = {}, seeded = true): Args {
  const story = storyMain(options);
  const empty = chapterOpened();
  const head = seeded ? story.seedChapter(empty.chapter.id, empty.variant, opening) : null;
  const chapter = head ? { ...chapterOpened(opening, head), digest: 'b'.repeat(64) } : empty;
  return { story, agent: agents[0]!, book, chapter, locale: 'en', messages, delay: 150, main: story.main };
}

const meta = {
  title: 'Studio/Chapter',
  component: ChapterEditor,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/x/chapters/y' } },
  beforeEach() { localStorage.clear(); },
  render: ({ story: _story, ...props }: Args) => <ChapterEditor {...props} />,
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

async function append(editor: HTMLElement, text: string) {
  const area = editor as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  await userEvent.type(area, text, { skipClick: true });
}

const status = (canvasElement: HTMLElement) => within(canvasElement).getAllByRole('status')
  .find(element => element.closest('[data-slot="autosave-status"]'))!;

/** The first lines of a new chapter: the first save starts its draft, and this device remembers where it stands. */
export const FirstDraft: Story = {
  args: page({}, false),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole('textbox', { name: 'Chapter text' });
    await expect(editor).toHaveAttribute('lang', 'zh-Hans');
    await expect(canvas.getByRole('link', { name: 'Back to the chapters' })).toHaveTextContent('雨夜书店');
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.type(editor, '末班车到站时，整座站台只有她一个人。');
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['draft']);
    await expect(canvas.getByText('18 characters')).toBeInTheDocument();
    const memory = readChapterMemory(localStorage, chapterMemoryKey(agents[0]!.iri, args.chapter.variant));
    await expect(memory).toMatchObject({ head: args.story!.chapterHead(args.chapter.variant), length: 18 });
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeEnabled();
  },
};

/** Another device saved first. Main names the head that won; Studio reads that exact version to compare. */
export const Conflict: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    args.story!.writeChapterElsewhere(args.chapter.chapter.id, args.chapter.variant, `${opening}\n另一台设备写下的一段。`);
    await append(canvas.getByRole('textbox', { name: 'Chapter text' }), '\n我写下的一段。');
    await expect(await canvas.findByRole('alert', {}, { timeout: 3_000 })).toHaveTextContent(
      'This text was changed somewhere else');
    await expect(await canvas.findByText('另一台设备写下的一段。')).toBeInTheDocument();
    // Nothing of the writer's is lost: it stays on this device until they choose.
    await expect(localStorage.getItem(localDraftKey(agents[0]!.iri, args.chapter.chapter.id, args.chapter.variant)))
      .toContain('我写下的一段');
    await userEvent.click(canvas.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['draft', 'draft']);
  },
};

export const ConflictTakeTheirs: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    args.story!.writeChapterElsewhere(args.chapter.chapter.id, args.chapter.variant, `${opening}\n另一台设备写下的一段。`);
    await append(canvas.getByRole('textbox', { name: 'Chapter text' }), '\n我的。');
    await userEvent.click(await canvas.findByRole('button', { name: 'Use the saved one' }, { timeout: 3_000 }));
    await expect(canvas.getByRole('textbox', { name: 'Chapter text' })).toHaveValue(`${opening}\n另一台设备写下的一段。`);
  },
};

/** Publishing makes the chapter readable; the next publication is an update that names the one it replaces. */
export const PublishAndUpdate: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const body = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    let dialog = within(await body.findByRole('dialog'));
    await expect(dialog.getByRole('heading', { name: 'Publish “第三章 最后一班车”' })).toBeInTheDocument();
    await expect(dialog.getByText('In “雨夜书店” on REZICS, for everyone to read')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('checkbox', { name: /I wrote this text/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(within(dialog.getByRole('list', { name: 'Publish' })).getAllByText('Done')).toHaveLength(2));
    await userEvent.click(dialog.getAllByRole('button', { name: 'Close' }).at(-1)!);
    await append(canvas.getByRole('textbox', { name: 'Chapter text' }), '\n她上了车。');
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await userEvent.click(canvas.getByRole('button', { name: 'Publish update' }));
    dialog = within(await body.findByRole('dialog'));
    await expect(dialog.getByRole('heading', { name: 'Publish an update to “第三章 最后一班车”' })).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('checkbox', { name: /I wrote this text/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(within(dialog.getByRole('list', { name: 'Publish' })).getAllByText('Done')).toHaveLength(2));
    await expect(args.story!.calls).toEqual(['publish-chapter', 'eligibility', 'draft', 'publish-chapter', 'eligibility']);
    const memory = readChapterMemory(localStorage, chapterMemoryKey(agents[0]!.iri, args.chapter.variant));
    await expect(memory?.publishedHead).toBe(args.story!.chapterHead(args.chapter.variant));
  },
};

export const PublishDenied: Story = {
  args: page({ publish: 'denied' }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('checkbox', { name: /I wrote this text/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('This identity can’t publish this text.');
  },
};

export const Chinese: Story = {
  args: { ...page(), locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: '章节正文' })).toBeInTheDocument();
    await expect(canvas.getByText('26 字')).toBeInTheDocument();
  },
};

export const Dark: Story = { args: page(), globals: { theme: 'dark' } };

export const Phone: Story = {
  args: page(),
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** Clearing all text still saves an exact draft; publishing stays disabled. */
export const EmptyDraftSaves: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole('textbox', { name: 'Chapter text' });
    await userEvent.clear(editor);
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(editor).toHaveValue('');
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expect(args.story!.calls).toEqual(['draft']);
    const head = args.story!.chapterHead(args.chapter.variant)!;
    const read = await args.main!.v1['content-revisions']({ revision: head }).get({ query: { actingSubject: agents[0]!.iri } });
    await expect(read.data?.body.body).toBe('');
    await expect(readChapterMemory(localStorage, chapterMemoryKey(agents[0]!.iri, args.chapter.variant)))
      .toMatchObject({ head, length: 0 });
    await expect(localStorage.getItem(localDraftKey(agents[0]!.iri, args.chapter.chapter.id, args.chapter.variant))).toBeNull();
  },
};
