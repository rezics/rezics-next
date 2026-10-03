import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, fireEvent, screen, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../../../../packages/ui/src/test/focus.ts';
import { detailsValues } from './details-api.ts';
import type { DetailsState, SaveDetails } from './details-form.tsx';
import { chapterVariant } from './content-api.ts';
import { agents, contents, history, ids, now, publishedTexts, realmOptions, serial, story, storyMain, tags }
  from './fixtures.ts';
import { chapterFacts as factsOf } from './outline.ts';
import type { ChapterFacts } from './read.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { StudioFrame } from './studio-frame.tsx';
import { StudioWork, type WorkTabContent } from './studio-work.tsx';
import type { ContentsPage, MyText } from './types.ts';

type Props = ComponentProps<typeof StudioWork>;

const base = '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/00000000-0000-4000-8000-000000000101';

/** A Book's chapters as Main's contents read returns them, from a stand-in Main that holds the Book's composition. */
function chaptersOf(main: ReturnType<typeof storyMain>): ContentsPage {
  const page = main.level(ids.serial);
  return { ...page, items: page.items.map((item, index) => ({ ...item,
    availability: index < 2 ? 'available' : 'unavailable' })) } as ContentsPage;
}

function chapters(options: Parameters<typeof storyMain>[0] = {}) {
  const main = storyMain(options);
  main.seedBook(ids.serial, [{ target: ids.chapters[0]!, title: '第一章 雨夜' },
    { target: ids.chapters[1]!, title: '第二章 未寄出的信' }, { target: ids.chapters[2]!, title: '第三章 最后一班车' }]);
  return { main, content: { tab: 'chapters', chapters: { page: { ok: true, data: chaptersOf(main) },
    main: main.main } } as WorkTabContent };
}

const chapterIds = [...ids.chapters, 'https://rezics.com/id/00000000-0000-4000-8000-000000000114',
  'https://rezics.com/id/00000000-0000-4000-8000-000000000115'];
/**
 * 雨夜书店 as a writer keeps it: two volumes and its extras (番外). The second
 * volume is the one being written, so it arrives open with its chapters.
 */
function volumes(options: Parameters<typeof storyMain>[0] = {}) {
  const main = storyMain(options);
  const characters = (value: number) => ({ unit: 'characters' as const, value });
  main.seedOutline(ids.serial, [
    { title: '第一卷 雨夜', division: 'volume', chapters: [
      { target: chapterIds[0]!, title: '第一章 雨夜', state: 'published', length: characters(2345) },
      { target: chapterIds[1]!, title: '第二章 未寄出的信', state: 'changed', length: characters(1820) }] },
    { title: '第二卷 雨停之后', division: 'volume', chapters: [
      { target: chapterIds[2]!, title: '第三章 最后一班车', state: 'draft', length: characters(960) },
      { target: chapterIds[3]!, title: '第四章 站台', state: 'draft', length: characters(12) }] },
    { title: '番外', division: 'extras', chapters: [
      { target: chapterIds[4]!, title: '书店的猫', state: 'empty' }] },
  ]);
  const top = main.level(ids.serial);
  const second = top.items[1]!.occurrence;
  const facts = async (parent?: string) => {
    const read = await main.main.v1.me.agents({ agent: agents[0]!.iri.slice(-36) }).works({ id: ids.serial.slice(-36) })
      .chapters.get({ query: { language: 'zh-Hans', ...(parent ? { parent } : {}) } });
    return factsOf(agents[0]!, agents, read.data!.page, read.data!.facts);
  };
  return { main, top, second, content: { tab: 'chapters', chapters: { page: { ok: true, data: top }, main: main.main,
    agents, facts: facts(), opened: { occurrence: second, page: main.level(ids.serial, second), facts: facts(second) },
    now } } as WorkTabContent };
}

/**
 * Picks an item from the open menu with the keyboard, as a keyboard user moves
 * a chapter; pointer presses in menus opened by earlier stories' layers are not
 * reliable in one test page.
 */
async function choose(name: string | RegExp) {
  const item = await screen.findByRole('menuitem', { name });
  await waitFor(() => expect(item.closest('[data-part=content]')).toHaveFocus());
  for (let step = 0; step < 8 && !item.hasAttribute('data-highlighted'); step++) await userEvent.keyboard('{ArrowDown}');
  await expect(item).toHaveAttribute('data-highlighted');
  await userEvent.keyboard('{Enter}');
}

/** Opens a chapter's or volume's handle and picks one of its moves, or a volume under its "Move to" heading. */
async function moveBy(canvasElement: HTMLElement, title: string, move: RegExp | string, into?: string) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: `Move “${title}”` }));
  if (!into) return choose(move);
  const heading = await screen.findByText(/^(Move to|移到)$/);
  await expect(heading.closest('[role=group]')).toContainElement(await screen.findByRole('menuitem', { name: into }));
  await choose(into);
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
  beforeEach({ args }) {
    localStorage.clear();
    (args as unknown as { main?: ReturnType<typeof storyMain> }).main?.reset();
  },
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
    // Each chapter moves from its handle's menu, which the keyboard reaches; the first cannot go up.
    await userEvent.click(canvas.getByRole('button', { name: 'Move “第一章 雨夜”' }));
    await expect(await screen.findByRole('menuitem', { name: 'Move “第一章 雨夜” up' }))
      .toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await moveBy(canvasElement, '第三章 最后一班车', 'Move “第三章 最后一班车” up');
    await waitFor(() => expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('第三章 最后一班车'));
    await expect(canvas.getByText('Moved “第三章 最后一班车”.')).toBeInTheDocument();
    await waitForFocus(canvasElement, 5000);
    const title = canvas.getByRole('textbox', { name: 'New chapter' });
    await userEvent.click(title);
    await waitForFocus(title, 5000);
    await userEvent.type(title, '第四章 站台');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'New chapter' })).toHaveValue('第四章 站台'));
    await userEvent.click(canvas.getByRole('button', { name: 'Add chapter' }));
    // The chapter is written through the story's Main double; under load that round trip exceeds the default wait.
    await expect(await canvas.findByRole('link', { name: 'Write “第四章 站台”' }, { timeout: 5000 })).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'New chapter' })).toHaveValue('');
    // A chapter just added moves at once: the list was read again with its place.
    await moveBy(canvasElement, '第四章 站台', 'Move “第四章 站台” up');
    await waitFor(() => expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('第四章 站台'),
      { timeout: 5000 });
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

/**
 * A Book in volumes, as long serials are built: each volume a section that
 * opens and closes, the one being written open; chapters numbered through the
 * Book (extras unnumbered), each with where it stands and how long it is.
 * A chapter moves into another volume from its handle's menu; a new volume is
 * made, a chapter added to it, and a volume renamed; one with chapters can't
 * be deleted.
 */
export const Volumes: Story = {
  args: (() => { const setup = volumes(); return { content: setup.content, main: setup.main }; })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const calls = (args as unknown as { main: ReturnType<typeof storyMain> }).main.calls;
    const first = canvas.getByRole('button', { name: /^第一卷 雨夜/ });
    const second = canvas.getByRole('button', { name: /^第二卷 雨停之后/ });
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    // Its title already says 第一卷, so no second volume number is added.
    await expect(first).toHaveTextContent('2 chapters');
    await expect(first).not.toHaveTextContent('Volume 1');
    await expect(second).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('button', { name: /^番外/ })).toHaveTextContent('Extras · 1 chapter');
    const draft = await canvas.findByRole('link', { name: 'Write “第三章 最后一班车”' });
    const row = draft.closest('li')!;
    await expect(row).toHaveTextContent('3');
    await waitFor(() => expect(row).toHaveTextContent('960 characters'));
    await expect(row).toHaveTextContent('Draft');
    // A closed volume reads its chapters when it opens: numbered through the Book, with where each stands.
    await userEvent.click(first);
    const changed = (await canvas.findByRole('link', { name: 'Write “第二章 未寄出的信”' })).closest('li')!;
    await waitFor(() => expect(changed).toHaveTextContent('Unpublished changes'));
    await expect(changed).toHaveTextContent('1,820 characters');
    // Into the other volume from the handle's menu, as the keyboard does it.
    await moveBy(canvasElement, '第二章 未寄出的信', '', '第二卷 雨停之后');
    await waitFor(() => expect(second).toHaveTextContent('3 chapters'), { timeout: 5000 });
    await expect(canvas.getByText('Moved “第二章 未寄出的信” into “第二卷 雨停之后”.')).toBeInTheDocument();
    await expect(first).toHaveTextContent('1 chapter');
    // A new volume, then its first chapter: new chapters go to the end of the volume chosen below.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'New volume' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'New volume' }));
    await waitForFocus(canvasElement, 5000);
    const volumeTitle = canvas.getByRole('textbox', { name: /Title/ });
    await userEvent.click(volumeTitle);
    await waitForFocus(volumeTitle, 5000);
    await userEvent.type(volumeTitle, '第三卷 晴');
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    const third = await canvas.findByRole('button', { name: /^第三卷 晴/ }, { timeout: 5000 });
    // Extras close the book: the new volume stands before them.
    const order = () => canvas.getAllByRole('button', { name: /^(第.卷|番外)/ }).map(button => button.textContent ?? '');
    await expect(order().findIndex(name => name.startsWith('第三卷')))
      .toBeLessThan(order().findIndex(name => name.startsWith('番外')));
    await expect(canvas.getByRole('combobox', { name: 'Add to' })).toHaveTextContent('第三卷 晴');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Add chapter' })).toBeEnabled());
    await userEvent.type(canvas.getByRole('textbox', { name: 'New chapter' }), '第五章 放晴');
    await userEvent.click(canvas.getByRole('button', { name: 'Add chapter' }));
    await waitFor(() => expect(third).toHaveTextContent('1 chapter'), { timeout: 5000 });
    await expect(await canvas.findByRole('link', { name: 'Write “第五章 放晴”' }, { timeout: 5000 })).toBeVisible();
    // Rename the extras; a volume with chapters offers no delete.
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Actions for “番外”' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Actions for “番外”' }));
    await choose('Rename');
    // The closing menu returns focus to its handle after the inline field mounts.
    await waitForFocus(canvasElement, 5000);
    const name = canvas.getByRole('textbox', { name: 'New title for “番外”' });
    await userEvent.click(name);
    await waitForFocus(name, 5000);
    await userEvent.clear(name);
    await userEvent.type(name, '番外篇');
    await expect(name).toHaveValue('番外篇');
    // Submit separately, after the typed title has reached the controlled field.
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByRole('button', { name: /^番外篇/ }, { timeout: 5000 })).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Actions for “第三卷 晴”' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Actions for “第三卷 晴”' }));
    await expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await expect(calls).toEqual(['move', 'insert', 'work', 'insert', 'update']);
  },
};

/**
 * Several chapters at once: selecting them brings up a toolbar that publishes
 * each one's latest draft, or moves them together into a volume.
 */
export const BulkActions: Story = {
  args: (() => {
    const setup = volumes();
    return { content: setup.content, main: setup.main };
  })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const main = (args as unknown as { main: ReturnType<typeof storyMain> }).main;
    // The drafts the selected chapters publish, saved as the chapter editor saves them.
    for (const chapter of [chapterIds[2]!, chapterIds[3]!]) {
      main.seedChapter(chapter, await chapterVariant(chapter, 'zh-Hans'), '雨停了。');
    }
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Select “第三章 最后一班车”' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “第四章 站台”' }));
    const bar = await screen.findByRole('toolbar', { name: 'Actions for the selected chapters' });
    await expect(bar).toHaveTextContent('2 selected');
    await userEvent.click(within(bar).getByRole('button', { name: 'Publish' }));
    await expect(await canvas.findByText('Published 2 chapters.', {}, { timeout: 5000 })).toBeInTheDocument();
    await expect(main.calls.filter(call => call === 'publish-chapter')).toHaveLength(2);
    // Moving together, into the extras.
    await waitFor(() => expect(canvas.getByRole('checkbox', { name: 'Select “第三章 最后一班车”' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “第三章 最后一班车”' }));
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Select “第四章 站台”' }));
    const again = await screen.findByRole('toolbar', { name: 'Actions for the selected chapters' });
    await userEvent.click(within(again).getByRole('button', { name: 'Move to' }));
    await choose('番外');
    await waitFor(() => expect(canvas.getByRole('button', { name: /^番外/ })).toHaveTextContent('3 chapters'), { timeout: 5000 });
    await expect(canvas.getByRole('button', { name: /^第二卷 雨停之后/ })).toHaveTextContent('0 chapters');
  },
};

/** Dragging by the grip: a chapter dropped on a volume's header goes to its end; a volume dropped on the upper half of another moves before it. */
export const DragAndDrop: Story = {
  args: (() => { const setup = volumes(); return { content: setup.content, main: setup.main }; })() as never,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A pointer presses the grip, moves past the lift threshold, then over the target, and lets go.
    const drag = async (source: HTMLElement, target: HTMLElement, clientY: number) => {
      const offset = clientY - target.getBoundingClientRect().top;
      source.scrollIntoView({ block: 'center' });
      const from = source.getBoundingClientRect();
      const x = from.left + from.width / 2, y = from.top + from.height / 2;
      await fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: x, clientY: y });
      await fireEvent.pointerMove(window, { pointerId: 1, clientX: x + 8, clientY: y + 8 });
      // Hit testing uses viewport coordinates; the manager's iframe can be shorter
      // than Vitest's viewport, so bring the drop target into view during the drag.
      target.scrollIntoView({ block: 'center' });
      const bounds = target.getBoundingClientRect();
      const to = bounds.left + 40;
      clientY = bounds.top + offset;
      await fireEvent.pointerMove(window, { pointerId: 1, clientX: to, clientY });
      await fireEvent.pointerUp(window, { pointerId: 1, clientX: to, clientY });
    };
    // The grip beside each Move button is what a pointer drags.
    const grip = (button: HTMLElement) => button.parentElement!.querySelector<HTMLElement>('[data-drag-handle]')!;
    const handle = grip(await canvas.findByRole('button', { name: 'Move “第四章 站台”' }));
    const extras = canvas.getByRole('button', { name: /^番外/ }).parentElement!;
    await drag(handle, extras, extras.getBoundingClientRect().top + 4);
    await waitFor(() => expect(canvas.getByRole('button', { name: /^番外/ })).toHaveTextContent('2 chapters'), { timeout: 5000 });
    await expect(canvas.getByText('Moved “第四章 站台” into “番外”.')).toBeInTheDocument();
    const moveSecond = canvas.getByRole('button', { name: 'Move “第二卷 雨停之后”' });
    await waitFor(() => expect(moveSecond).toBeEnabled());
    const second = grip(moveSecond);
    const firstHeader = canvas.getByRole('button', { name: /^第一卷 雨夜/ }).parentElement!;
    await drag(second, firstHeader, firstHeader.getBoundingClientRect().top + 1);
    await waitFor(() => expect(canvas.getAllByRole('button', { name: /^第.卷/ })[0]).toHaveAccessibleName(/^第二卷 雨停之后/), { timeout: 5000 });
  },
};

export const VolumesChinese: Story = {
  args: (() => { const setup = volumes(); return { content: setup.content, locale: 'zh-Hans',
    messages: { ...messages, ...zhHans } }; })() as never,
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /^第一卷 雨夜/ })).toHaveTextContent('第一卷 雨夜2 章');
    await expect(canvas.getByRole('button', { name: /^番外/ })).toHaveTextContent('番外 · 1 章');
    await expect(await canvas.findByText('960 字')).toBeVisible();
    await expect(canvas.getByRole('button', { name: '新建分卷' })).toBeVisible();
  },
};

export const VolumesDark: Story = {
  args: (() => { const setup = volumes(); return { content: setup.content }; })() as never,
  globals: { theme: 'dark' },
};

export const VolumesPhone: Story = {
  args: (() => { const setup = volumes(); return { content: setup.content }; })() as never,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('link', { name: 'Write “第三章 最后一班车”' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
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
    await expect(within(form).getByRole('combobox', { name: 'Status' })).toHaveTextContent('Ongoing');
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
    realms: { ok: true, data: realmOptions }, open: [ids.realms[1]!], main: main.main,
    loadRealms: async ({ q }) => ({ items: realmOptions.filter(item => item.name.value.toLowerCase().includes(q.toLowerCase()))
      .map(item => ({ value: item.id, label: item.name.value, realm: item, disabled: item.id === ids.realms[1] })),
      nextCursor: null, complete: true }) } } as WorkTabContent };
}

/** Each Realm says who decides; one already reviewing the Work is not offered again. */
export const Realms: Story = {
  args: (() => { const setup = realms(); return { content: setup.content, main: setup.main }; })() as never,
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Find a community' }));
    const choices = within(document.body);
    await expect(await choices.findByRole('option', { name: /Chinese Web Fiction/ })).toHaveAttribute('data-disabled');
    await expect(canvas.getByText('The Realm reviews your published Simplified Chinese text.')).toBeInTheDocument();
    await userEvent.click(choices.getByRole('option', { name: /Classic Literature/ }));
    // The picker can retain its closing option list; scope the policy to the submission form.
    const submit = canvas.getByRole('button', { name: 'Submit' });
    await expect(within(submit.closest('form')!).getByText('Moderators review every submission'))
      .toBeVisible();
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
    await userEvent.click(canvas.getByRole('combobox', { name: 'Find a community' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: /Open Shelf/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Submit' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Submitted to Open Shelf · 开放书架 and accepted.');
  },
};

export const RealmRefused: Story = {
  args: (() => { const setup = realms({ submit: 'denied' }); return { content: setup.content }; })() as never,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: 'Find a community' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: /Classic Literature/ }));
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
