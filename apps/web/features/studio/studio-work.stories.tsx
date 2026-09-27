import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import type { DetailsState, SaveDetails } from './details-form.tsx';
import { agents, header, submissions, texts } from './fixtures.ts';
import { messages } from './messages.ts';
import { type NewWorkState, NewWorkForm } from './new-work-form.tsx';
import { StudioWork } from './studio-work.tsx';

// A Work in Studio (texts, details, Realm decisions) and the new-work form.
// Server actions are stand-ins that answer the way Main does.

const details: DetailsState = { status: 'idle', head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000950',
  values: { originalTitle: '', originalLanguage: '', entries: [{ language: 'zh-Hans', title: '雨夜书店 · 第三章 最后一班车',
    description: '末班车到站时，整座站台只有她一个人。' }] } };
const work = { header, metadata: { ok: true as const, data: { work: header.id, revision: details.head, originalTitle: null,
  localized: [], sourcePosition: { dataEpoch: 'story', sequence: '1' } } },
texts: { ok: true as const, data: texts.filter(text => text.work?.id === 'https://rezics.com/id/00000000-0000-4000-8000-000000000102') },
submissions: { ok: true as const, data: submissions.slice(0, 1) },
realms: { [submissions[0]!.realm]: '中文网络小说 · Chinese Web Fiction' } };

const answer = (state: Omit<DetailsState, 'values' | 'head'>): SaveDetails => fn(async input =>
  ({ head: input.head, values: input.values, ...state }));

const meta = {
  title: 'Studio/Work',
  component: StudioWork,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001/works/x' } },
  args: { agent: agents[0]!, work: work as never, details, locale: 'en', messages: messages.en,
    saveDetails: answer({ status: 'saved' }) },
} satisfies Meta<typeof StudioWork>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'zh-Hans');
    const text = within(canvas.getByRole('region', { name: 'Text' }));
    await expect(text.getAllByRole('listitem')[0]).toHaveTextContent('Simplified Chinese');
    await expect(text.getByRole('link', { name: 'Continue writing' })).toHaveAttribute('href', expect.stringContaining('/write/'));
    await expect(text.getByText('Waiting for review')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Save details' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Details saved.');
  },
};

/** Main does not let a Work's creator edit its details yet; the form says so and keeps the values. */
export const DetailsDenied: Story = {
  args: { saveDetails: answer({ status: 'denied' }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save details' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('This identity can’t edit this work’s details yet.');
    await expect(canvas.getByRole('textbox', { name: 'Description' })).toHaveValue('末班车到站时，整座站台只有她一个人。');
  },
};

/** Someone saved first: the writer's values stay and the saved ones are shown beside them. */
export const DetailsChangedElsewhere: Story = {
  args: { saveDetails: answer({ status: 'stale',
    theirs: [{ language: 'zh-Hans', title: '雨夜书店 · 第三章', description: '另一个版本的简介。' }] }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save details' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Someone changed these details meanwhile.');
    await expect(canvas.getByText(/另一个版本的简介/)).toBeInTheDocument();
  },
};

export const NoTextYet: Story = {
  args: { work: { ...work, texts: { ok: true, data: [] }, submissions: { ok: true, data: [] } } as never },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Write the first lines' })).toHaveAttribute('href',
      expect.stringContaining('/write?language=en'));
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/studio/@agent-00000000-0000-4000-8000-000000000001/works/x' } },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

const created = fn(async (previous: NewWorkState): Promise<NewWorkState> =>
  ({ status: 'pending', message: messages.en.createPending, key: previous.key,
    values: { title: 'Notes on a City of Rivers', type: 'book', language: 'en' } }));

/** The new-work form names the identity on its button, so nobody creates as someone else by accident. */
export const NewWork: Story = {
  render: args => <PageContainer className="grid max-w-2xl gap-8">
    <PageHeader title={args.messages.newHeading} description={args.messages.newHelp} />
    <NewWorkForm agent={args.agent} action={created} initialState={{ status: 'idle', key: 'story-key' }}
      locale={args.locale} messages={args.messages} /></PageContainer>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Title' }), 'Notes on a City of Rivers');
    await userEvent.click(canvas.getByText('A story or chapter'));
    await expect(canvas.getByRole('radio', { name: /A story or chapter/ })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Create as Lin Mei 林梅' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent('still being set up');
    await expect(created).toHaveBeenCalled();
  },
};

export const NewWorkChinese: Story = {
  ...NewWork,
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '以 Lin Mei 林梅 身份创建' })).toBeInTheDocument();
    await expect(canvas.getByRole('combobox', { name: '写作语言' })).toHaveValue('zh-Hans');
  },
};

export const NewWorkPhone: Story = {
  ...NewWork,
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
