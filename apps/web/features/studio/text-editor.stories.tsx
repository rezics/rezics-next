import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { agents, header, realms, storyMain } from './fixtures.ts';
import { localDraftKey } from './local-draft.ts';
import { messages } from './messages.ts';
import { TextEditor, type TextEditorProps } from './text-editor.tsx';

// The writing page with an in-memory Main (fixtures.ts): autosave, offline,
// a conflict from another tab, a restored device copy and publishing. Each
// story makes its own Main so stories never share state.

const text = 'https://rezics.com/id/00000000-0000-4000-8000-000000000201';
const opening = '第三章 最后一班车\n末班车到站时，整座站台只有她一个人。';
const work = { id: header.id, title: header.title, mainVersion: header.mainVersion };

function page(options: Parameters<typeof storyMain>[0] = {}, seeded = true): TextEditorProps & { story: ReturnType<typeof storyMain> } {
  const story = storyMain(options);
  const head = seeded ? story.seed(text, opening, 'zh-Hans', header.id) : null;
  return { story, agent: agents[0]!, work, language: 'zh-Hans', text: seeded ? text : null,
    initial: { head, body: seeded ? opening : '', publication: 'draft' }, realms: { ok: true, data: realms },
    locale: 'en', messages: messages.en, delay: 150, main: story.main };
}

const meta = {
  title: 'Studio/Write',
  component: TextEditor,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/x/write' } },
  beforeEach() { localStorage.clear(); },
  render: ({ story: _story, ...props }: TextEditorProps & { story?: ReturnType<typeof storyMain> }) => <TextEditor {...props} />,
} satisfies Meta<TextEditorProps & { story?: ReturnType<typeof storyMain> }>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Types at the end of the text, as a writer continuing a chapter does. */
async function append(editor: HTMLElement, text: string) {
  const area = editor as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  await userEvent.type(area, text, { skipClick: true });
}

const status = (canvasElement: HTMLElement) => within(canvasElement).getAllByRole('status')
  .find(element => element.closest('[data-slot="autosave-status"]'))!;

export const Autosave: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole('textbox', { name: 'Text' });
    await expect(editor).toHaveAttribute('lang', 'zh-Hans');
    await expect(canvas.getByText('Writing as Lin Mei 林梅', { exact: false })).toBeInTheDocument();
    await append(editor, '\n她打开了那封信。');
    await expect(status(canvasElement)).toHaveTextContent('Unsaved changes');
    // Kept on the device before Main has it.
    await expect(localStorage.getItem(localDraftKey(agents[0]!.iri, header.id, text))).toContain('她打开了那封信');
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['edit']);
    await expect(localStorage.getItem(localDraftKey(agents[0]!.iri, header.id, text))).toBeNull();
    await expect(canvas.getByText(/\d+ words/)).toBeInTheDocument();
  },
};

export const FirstLines: Story = {
  args: page({}, false),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole('textbox', { name: 'Text' });
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.type(editor, '第一章 雨夜');
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['create']);
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeEnabled();
  },
};

let networkDown = true;
export const Offline: Story = {
  args: page({ offline: () => networkDown }),
  async play({ canvasElement, args }) {
    networkDown = true;
    const canvas = within(canvasElement);
    await append(canvas.getByRole('textbox', { name: 'Text' }), '\n雨还在下。');
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent('Offline — kept on this device'));
    await expect(localStorage.getItem(localDraftKey(agents[0]!.iri, header.id, text))).toContain('雨还在下');
    networkDown = false;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['edit']);
  },
};

export const ConflictKeepMine: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    // Another tab saves first.
    args.story!.writeElsewhere(text, `${opening}\n另一台设备写下的一段。`);
    await append(canvas.getByRole('textbox', { name: 'Text' }), '\n我写下的一段。');
    const alert = await canvas.findByRole('alert', {}, { timeout: 3_000 });
    await expect(alert).toHaveTextContent('This text was changed somewhere else');
    await expect(canvas.getByRole('textbox', { name: 'Text' })).toHaveAttribute('readonly');
    await expect(await canvas.findByText('另一台设备写下的一段。')).toBeInTheDocument();
    await expect(canvas.getByText('我写下的一段。')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(canvas.queryByRole('button', { name: 'Keep mine' })).toBeNull();
  },
};

export const ConflictTakeTheirs: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    args.story!.writeElsewhere(text, `${opening}\n另一台设备写下的一段。`);
    await append(canvas.getByRole('textbox', { name: 'Text' }), '\n我的。');
    await userEvent.click(await canvas.findByRole('button', { name: 'Use the saved one' }, { timeout: 3_000 }));
    await expect(canvas.getByRole('textbox', { name: 'Text' })).toHaveValue(`${opening}\n另一台设备写下的一段。`);
    await expect(status(canvasElement)).toHaveTextContent(/^Saved · /);
  },
};

/** Without Main's text list the other version cannot be read: nothing to compare, the text stays and can be copied. */
export const ConflictUnreadable: Story = {
  args: page({ listTexts: false }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    args.story!.writeElsewhere(text, 'elsewhere');
    await append(canvas.getByRole('textbox', { name: 'Text' }), '\n我的。');
    await expect(await canvas.findByText(/saved version can’t be loaded yet/, {}, { timeout: 3_000 })).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Keep mine' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Copy mine' })).toBeInTheDocument();
  },
};

/** Another tab on this device saved first: its announcement lets this tab compare even where Main cannot list texts. */
export const ConflictFromAnotherTab: Story = {
  args: page({ listTexts: false }),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const body = `${opening}\n另一个标签页写下的一段。`;
    args.story!.writeElsewhere(text, body);
    const tab = new BroadcastChannel('rezics:studio:saves');
    tab.postMessage({ agent: agents[0]!.iri, text, head: args.story!.head(text), body });
    tab.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    await append(canvas.getByRole('textbox', { name: 'Text' }), '\n这个标签页的一段。');
    await expect(await canvas.findByText('另一个标签页写下的一段。', {}, { timeout: 3_000 })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
    await expect(args.story!.calls).toEqual(['edit', 'edit']);
  },
};

export const RestoredFromDevice: Story = {
  args: page(),
  beforeEach() {
    localStorage.clear();
    // The seeded head is the first revision the in-memory Main mints.
    localStorage.setItem(localDraftKey(agents[0]!.iri, header.id, text), JSON.stringify({ body: `${opening}\n没保存的一段。`,
      base: 'https://rezics.com/id/00000000-0000-4000-8000-000000001001', changedAt: '2026-09-28T12:00:00Z' }));
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Restored text you hadn’t saved yet from this device.')).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: 'Text' })).toHaveValue(`${opening}\n没保存的一段。`);
    await waitFor(() => expect(status(canvasElement)).toHaveTextContent(/^Saved · /));
  },
};

export const Publish: Story = {
  args: page(),
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await expect(dialog.getByRole('heading', { name: /Publish “雨夜书店/ })).toBeInTheDocument();
    await expect(dialog.getByText('Published as')).toBeInTheDocument();
    await expect(dialog.getByText('Lin Mei 林梅')).toBeInTheDocument();
    await expect(dialog.getByText('On REZICS, for everyone to read')).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: /I wrote this text/ }));
    await userEvent.click(dialog.getByRole('checkbox', { name: /Classic Literature/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    const steps = await dialog.findByRole('list', { name: 'Publish' });
    await waitFor(() => expect(within(steps).getAllByText('Done')).toHaveLength(3));
    await expect(args.story!.calls).toEqual(['publish', 'select', 'submit']);
  },
};

export const PublishRealmRefused: Story = {
  args: page({ submit: 'denied' }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('checkbox', { name: /I wrote this text/ }));
    await userEvent.click(dialog.getByRole('checkbox', { name: /Chinese Web Fiction/ }));
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }));
    await expect(await dialog.findByText('This identity can’t submit to this Realm yet.')).toBeInTheDocument();
    await expect(dialog.getAllByText('Done')).toHaveLength(2);
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
  args: { ...page(), locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: '正文' })).toHaveAttribute('placeholder', '开始写作。每一行是一个段落。');
    await expect(canvas.getByRole('button', { name: '发布' })).toBeInTheDocument();
    await expect(canvas.getByText(/\d+ 字/)).toBeInTheDocument();
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

/** A long unbroken title truncates in the toolbar and wraps in the heading instead of widening the page. */
export const PhoneLongTitle: Story = {
  args: { ...page({}, false), language: 'en',
    work: { ...work, title: { value: 'Browser Work 1790539651855 — Notes on a City of Rivers and Its Bridges', language: 'en' } } },
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const RightToLeft: Story = {
  args: { ...page({}, false), language: 'ar' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('textbox', { name: 'Text' })).toHaveAttribute('dir', 'rtl');
  },
};
