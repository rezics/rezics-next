import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { detailsValues } from './details-api.ts';
import type { DetailsState, SaveDetails } from './details-form.tsx';
import { agents, contents, history, ids, publishedTexts, realmOptions, serial, story, storyMain, tags } from './fixtures.ts';
import type { ChapterFacts } from './read.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { StudioFrame } from './studio-frame.tsx';
import { StudioWork, type WorkTabContent } from './studio-work.tsx';
import type { ContentsPage, MyText } from './types.ts';

type Props = ComponentProps<typeof StudioWork>;

const base = '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/00000000-0000-4000-8000-000000000101';

/** A Book's chapters as Main's contents read returns them, from a stand-in Main that holds the Book's composition. */
function chaptersOf(main: ReturnType<typeof storyMain>, structure: string): ContentsPage {
  const book = main.book(ids.serial)!;
  return { ...contents, composition: structure, compositionRevision: book.head,
    items: book.items.map((entry, index) => ({ occurrence: entry.occurrence, parent: structure, role: 'chapter',
      label: entry.label, target: entry.target, selectedRevision: null, progress: null,
      availability: index < 2 ? 'available' : 'unavailable' })) } as ContentsPage;
}

function chapters(options: Parameters<typeof storyMain>[0] = {}) {
  const main = storyMain(options);
  const structure = main.seedBook(ids.serial, [{ target: ids.chapters[0]!, title: '第一章 雨夜' },
    { target: ids.chapters[1]!, title: '第二章 未寄出的信' }, { target: ids.chapters[2]!, title: '第三章 最后一班车' }]);
  const page = chaptersOf(main, structure);
  return { main, content: { tab: 'chapters', chapters: { page: { ok: true, data: page }, main: main.main } } as WorkTabContent };
}

const details: DetailsState = { status: 'idle', head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000903',
  values: detailsValues(serial.metadata.ok ? serial.metadata.data : null, 'zh-Hans') };

const texts: MyText[] = [{ id: ids.texts.serial, work: null, revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000303',
  language: 'zh-Hans', publication: 'public' }] as MyText[];

const meta = {
  title: 'Studio/Work',
  component: StudioWork,
  parameters: { route: { pathname: base } },
  args: { agent: agents[0]!, work: serial, languages: ['zh-Hans'], content: chapters().content, locale: 'en', messages },
  beforeEach() { localStorage.clear(); },
  render: args => <StudioFrame agent={args.agent} agents={agents} session={args.agent} path="" locale={args.locale}
    messages={args.messages}><StudioWork {...args} /></StudioFrame>,
} satisfies Meta<Props>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A Book's chapters in order: where each stands, a new one added in place, and reordering on Main's head. */
export const Chapters: Story = {
  args: (() => { const setup = chapters(); return { content: setup.content, main: setup.main }; })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const calls = (args as unknown as { main: ReturnType<typeof storyMain> }).main.calls;
    await expect(canvas.getByRole('link', { name: 'Chapters' })).toHaveAttribute('aria-current', 'page');
    // The Work's kind and language come from its types and its Main Version, not from its title.
    await expect(canvas.getByRole('heading', { level: 1 }).parentElement).toHaveTextContent(/Book·Simplified Chinese·Ongoing/);
    const list = canvas.getByRole('list');
    await expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    await expect(within(list).getAllByText('Published')).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: 'Write “第一章 雨夜”' })).toHaveAttribute('href',
      expect.stringContaining('/chapters/00000000-0000-4000-8000-000000000111?language=zh-Hans'));
    await expect(canvas.getByRole('button', { name: 'Move “第一章 雨夜” up' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Move “第三章 最后一班车” up' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('第三章 最后一班车'));
    await expect(canvas.getByRole('status')).toHaveTextContent('Moved “第三章 最后一班车” to position 2.');
    await userEvent.type(canvas.getByRole('textbox', { name: 'New chapter' }), '第四章 站台');
    await userEvent.click(canvas.getByRole('button', { name: 'Add chapter' }));
    await expect(await canvas.findByRole('link', { name: 'Write “第四章 站台”' })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'New chapter' })).toHaveValue('');
    // A chapter just added moves at once: Main's answer named its place.
    await userEvent.click(canvas.getByRole('button', { name: 'Move “第四章 站台” up' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('第四章 站台'));
    await expect(calls).toEqual(['move', 'work', 'insert', 'move']);
  },
};

const chapterFacts: ChapterFacts = {
  [contents.items[0]!.occurrence]: { writer: { kind: 'self' }, state: 'changed' },
  [contents.items[1]!.occurrence]: { writer: { kind: 'self' }, state: 'published' },
  [contents.items[2]!.occurrence]: { writer: { kind: 'agent', agent: agents[1]! }, state: 'draft' },
  [contents.items[3]!.occurrence]: { writer: { kind: 'agent', agent: agents[1]! }, state: 'empty',
    target: 'https://rezics.com/id/00000000-0000-4000-8000-000000000114', label: { value: '第四章 站台', language: 'zh-Hans' } },
  'https://rezics.com/id/00000000-0000-4000-8000-000000001105': { writer: { kind: 'unknown' }, state: null },
};

/**
 * Where each chapter stands and who writes it, as Main says: the Studio Agent's own open with Write; one its pen
 * name writes, even a private one it can't see, opens with Switch in the pen name's Studio; one only someone else
 * can open stays closed.
 */
export const ChapterWriters: Story = {
  args: { content: { tab: 'chapters', chapters: { facts: Promise.resolve(chapterFacts), page: { ok: true, data: {
    ...contents, items: [...contents.items, { ...contents.items[3]!,
      occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000001105' }] } } } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const rows = within(canvas.getByRole('list')).getAllByRole('listitem');
    await waitFor(() => expect(rows[0]).toHaveTextContent('Unpublished changes'));
    await expect(rows[0]).toHaveTextContent('Published');
    await expect(rows[1]).toHaveTextContent('Published');
    await expect(within(rows[2]!).getByText('Draft')).toBeInTheDocument();
    await expect(rows[2]).toHaveTextContent('Written as 月下书生 · Moonlit Scribe');
    await expect(within(rows[2]!).queryByRole('link', { name: /^Write/ })).toBeNull();
    const pen = '/studio/@agent-00000000-0000-4000-8000-000000000002/works/00000000-0000-4000-8000-000000000101';
    await expect(canvas.getByRole('link', { name: 'Switch to 月下书生 · Moonlit Scribe to write “第三章 最后一班车”' }))
      .toHaveAttribute('href', expect.stringContaining(`${pen}/chapters/00000000-0000-4000-8000-000000000113?language=zh-Hans`));
    // A private chapter the pen name writes: its title and state come from the pen name's view.
    await expect(rows[3]).toHaveTextContent('第四章 站台');
    await expect(rows[3]).toHaveTextContent('Not started');
    await expect(canvas.getByRole('link', { name: 'Switch to 月下书生 · Moonlit Scribe to write “第四章 站台”' }))
      .toHaveAttribute('href', expect.stringContaining('/chapters/00000000-0000-4000-8000-000000000114'));
    await expect(rows[4]).toHaveTextContent('A private chapter by another writer');
    await expect(within(rows[4]!).queryAllByRole('link')).toHaveLength(0);
  },
};

/** The first chapter of a new Book: Studio makes the Book's composition first, then the chapter. */
export const FirstChapter: Story = {
  args: (() => { const main = storyMain(); return { main, content: { tab: 'chapters', chapters: {
    page: { ok: false, failure: 'none' }, main: main.main } } }; })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No chapters yet. Add the first one below.')).toBeInTheDocument();
    await userEvent.type(canvas.getByRole('textbox', { name: 'New chapter' }), '第一章 雨夜');
    await userEvent.click(canvas.getByRole('button', { name: 'Add chapter' }));
    await expect(await canvas.findByRole('link', { name: 'Write “第一章 雨夜”' })).toBeInTheDocument();
    await expect((args as unknown as { main: ReturnType<typeof storyMain> }).main.calls)
      .toEqual(['composition', 'work', 'insert']);
  },
};

export const ChaptersRefused: Story = {
  args: (() => { const setup = chapters({ chapters: 'denied' }); return { content: setup.content }; })() as never,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'New chapter' }), '第四章');
    await userEvent.click(canvas.getByRole('button', { name: 'Add chapter' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This identity can’t add chapters to this book.');
  },
};

/** A Book's own text is its introduction: what readers see first and what Realms review. */
export const Introduction: Story = {
  args: { content: { tab: 'text', texts: { ok: true, data: texts } } },
  parameters: { route: { pathname: base, search: 'tab=text' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Introduction' })).toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Continue writing' })).toHaveAttribute('href',
      expect.stringContaining('/write/00000000-0000-4000-8000-000000000203?revision='));
  },
};

/** A guide has no chapters: its text is the Work. Studio calls it what the catalogue does. */
export const StoryText: Story = {
  args: { work: story, languages: ['en'], content: { tab: 'text', texts: { ok: true, data: [] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 }).parentElement).toHaveTextContent(/Guide·English/);
    await expect(canvas.queryByRole('link', { name: 'Chapters' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Write the first lines' })).toHaveAttribute('href',
      expect.stringContaining('/write?language=en'));
  },
};

const saved: SaveDetails = async input => ({ status: 'saved', head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000904',
  values: input.values });

export const Details: Story = {
  args: { content: { tab: 'details', details, saveDetails: saved, cover: { cover: null }, tags: { ok: true, data: tags } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const form = canvas.getByRole('region', { name: 'Details' });
    await expect(within(form).getByRole('combobox', { name: 'Status' })).toHaveValue('ongoing');
    await expect(within(form).getByRole('textbox', { name: 'Tagline' })).toHaveValue('一封没有地址的信，把雨夜书店带向二十年前的秘密。');
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Description' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Description' }), '雨夜里的一家书店。');
    await userEvent.click(within(form).getByRole('button', { name: 'Save details' }));
    await expect(await within(form).findByRole('status')).toHaveTextContent('Details saved.');
    await expect(canvas.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
    await expect(canvas.getByText('Mystery · 悬疑')).toBeInTheDocument();
  },
};

/** Someone else saved the details first: the writer's values stay, the winning values show beside them. */
export const DetailsStale: Story = {
  args: { content: { tab: 'details', details, cover: { cover: null }, tags: { ok: true, data: tags },
    saveDetails: async input => ({ status: 'stale', head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000905',
      values: input.values, theirs: [{ language: 'zh-Hans', title: '', description: '另一位维护者写的简介', tagline: '',
        label: null }] }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save details' }));
    await expect(await canvas.findByText(/Someone changed these details meanwhile/)).toBeInTheDocument();
    await expect(canvas.getByText('另一位维护者写的简介')).toBeInTheDocument();
  },
};

function realms(options: Parameters<typeof storyMain>[0] = {}) {
  const main = storyMain(options);
  return { main, content: { tab: 'realms', history, submit: { texts: { ok: true, data: publishedTexts },
    realms: { ok: true, data: realmOptions }, open: [ids.realms[1]!], main: main.main } } as WorkTabContent };
}

/** Each Realm says who decides; one already reviewing the Work is not offered again. */
export const Realms: Story = {
  args: (() => { const setup = realms(); return { content: setup.content, main: setup.main }; })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const group = canvas.getByRole('group', { name: 'Realm' });
    await expect(group).toHaveTextContent('Moderators review every submission');
    await expect(group).toHaveTextContent('Submissions are accepted at once');
    await expect(within(group).getByRole('radio', { name: /Chinese Web Fiction/ })).toBeDisabled();
    await expect(canvas.getByText('The Realm reviews your published Simplified Chinese text.')).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('radio', { name: /Classic Literature/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Submit' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Submitted to Classic Literature · 经典文学. It’s waiting for review.');
    await expect((args as unknown as { main: ReturnType<typeof storyMain> }).main.calls).toEqual(['submit']);
    const history = canvas.getByRole('region', { name: 'Your submissions' });
    await expect(history).toHaveTextContent('Please add a content note for the opening chapter.');
  },
};

export const RealmOpen: Story = {
  args: (() => { const setup = realms({ submit: 'accepted' }); return { content: setup.content }; })() as never,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Open Shelf/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Submit' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Submitted to Open Shelf · 开放书架 and accepted.');
  },
};

export const RealmRefused: Story = {
  args: (() => { const setup = realms({ submit: 'denied' }); return { content: setup.content }; })() as never,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /Classic Literature/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Submit' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This identity can’t submit to this Realm.');
  },
};

/** Nothing published yet: a Book is reviewed through its introduction, so Studio says to publish that first. */
export const RealmsNeedText: Story = {
  args: { content: { tab: 'realms', history: { submissions: { ok: true, data: [] }, realms: {} },
    submit: { texts: { ok: true, data: [] }, realms: { ok: true, data: realmOptions }, open: [] } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Publish the introduction first/)).toBeInTheDocument();
    await expect(canvas.getByText('This work hasn’t been submitted to a Realm yet.')).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  args: (() => { const setup = chapters(); return { content: setup.content, locale: 'zh-Hans',
    messages: { ...messages, ...zhHans } }; })() as never,
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: '章节' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('heading', { level: 1 }).parentElement).toHaveTextContent(/图书·简体中文·连载中/);
    await expect(canvas.getByRole('button', { name: '添加章节' })).toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  args: (() => { const setup = chapters(); return { content: setup.content }; })() as never,
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneRealms: Story = {
  args: (() => { const setup = realms(); return { content: setup.content }; })() as never,
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
