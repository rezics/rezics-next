import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { Correction } from './commands.ts';
import { basis, ids } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHant from './messages/zh-Hant.ts';
import { ProposeCorrection, ProposeCorrectionPage } from './propose-correction.tsx';

const sent: { correction: Correction; key: string }[] = [];
const meta = {
  title: 'Proposals/Propose correction',
  component: ProposeCorrectionPage,
  parameters: { route: { pathname: '/en/proposals/new' } },
  args: { basis: { ok: true, data: basis }, actingSubject: ids.member, languages: ['zh-Hant'], locale: 'en', messages,
    create: (correction, key) => {
      sent.push({ correction, key });
      return Promise.resolve({ ok: true, data: { profile: 'editorial-command-v1', proposal: ids.proposal, revision: 1,
        outcome: 'created', replayed: false } });
    } },
  render: args => <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"><ProposeCorrectionPage {...args} /></div>,
} satisfies Meta<typeof ProposeCorrectionPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A reader changes a synopsis, cites a source and submits one create. */
export const SynopsisCorrection: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: /Language/ })).toHaveTextContent(/zh-Hant/);
    const synopsis = canvas.getByRole('textbox', { name: 'Synopsis' });
    await expect(synopsis).toHaveValue('一間只在下雨時開門的書店。');
    await userEvent.clear(synopsis);
    await userEvent.type(synopsis, '一間只在雨夜開門的書店。');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Source' }), 'https://example.com/books/rainy-night');
    await userEvent.click(canvas.getByRole('button', { name: 'Submit correction' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const { correction } = sent[0]!;
    await expect(correction.kind).toBe('component-correction');
    await expect(correction.baseHeads).toEqual(basis.baseHeads);
    await expect(correction.evidence[0]?.resource).toBe('https://example.com/books/rainy-night');
    await expect(JSON.stringify(correction.candidate)).toContain('一間只在雨夜開門的書店。');
    // The other language's text is carried over unchanged.
    await expect(JSON.stringify(correction.candidate)).toContain('A bookshop opens only when it rains.');
  },
};

export const NothingChanged: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Submit correction' }));
    await expect(await canvas.findByText('Change at least one of the fields first.')).toBeInTheDocument();
  },
};

export const SignedOut: Story = {
  args: { actingSubject: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Sign in to propose a correction.')).toBeVisible();
  },
};

export const Unreadable: Story = {
  args: { basis: { ok: false, failure: 'unavailable' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toBeVisible();
  },
};

/** The button a Work or entity page shows where the viewer cannot edit directly. */
export const InDialog: Story = {
  render: args => <div className="p-6"><ProposeCorrection {...args} defaultOpen /></div>,
  async play() {
    const dialog = within(document.body);
    const heading = await dialog.findByRole('heading', { name: 'Propose a correction' });
    await waitFor(() => expect(heading).toBeVisible());
  },
};

export const ChinesePhone: Story = {
  args: { locale: 'zh-Hant', messages: { ...messages, ...zhHant } },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/zh-Hant/proposals/new' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: '送出更正' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
