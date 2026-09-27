import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { type CreateState, CreateWorkForm } from './create-work-form.tsx';
import { CreateWorkReceipt } from './create-work-receipt.tsx';
import { messages } from './messages.ts';

const receipt = {
  work: 'https://rezics.com/id/57c86232-6db4-4b0d-aa56-e4ad584d07b4',
  mainVersion: 'https://rezics.com/id/e7137ee6-7208-44ac-99bd-31b4ad608709',
  workRevision: 'https://rezics.com/id/66bdf11c-5f26-402f-9614-4e5c5fc9f9ca',
  mainRevision: 'https://rezics.com/id/480c6271-112a-405a-8d8e-5ca4ad46ce45',
  sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '42' },
};

// Stands in for the server action: echoes the title back as a created Work.
async function created(_previous: CreateState, form: FormData): Promise<CreateState> {
  return { status: 'created', title: String(form.get('title')), receipt };
}

const meta = {
  title: 'Studio/Create a Work', component: CreateWorkForm,
  args: { action: created, messages: messages.en },
  decorators: [(Story, { args }) => <PageContainer className="grid max-w-2xl gap-6">
    <PageHeader title={args.messages.createHeading} description={args.messages.createHelp} /><Story />
  </PageContainer>],
} satisfies Meta<typeof CreateWorkForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Create: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Work title' }), 'Notes on a City of Rivers');
    await userEvent.click(canvas.getByRole('button', { name: 'Create Work' }));
    const status = await canvas.findByRole('status', { name: 'Work created' });
    await expect(status).toHaveTextContent('Notes on a City of Rivers');
    await expect(within(status).getAllByRole('definition')).toHaveLength(4);
  },
};

export const Denied: Story = {
  args: { initialState: { status: 'error', message: messages.en.denied } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(messages.en.denied);
  },
};

export const StillReconciling: Story = {
  args: { initialState: { status: 'pending', message: messages.en.pending, operationId: 'op-1' } },
};

export const CreatedLongTitle: Story = {
  render: args => <CreateWorkReceipt messages={args.messages} receipt={receipt}
    title="都市と川の記録 — Research notes and reflections across languages, regions and centuries" />,
};

export const ChineseCreated: Story = {
  args: { messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  render: args => <CreateWorkReceipt messages={args.messages} receipt={receipt} title="城市与河流笔记" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: '作品已创建' })).toBeInTheDocument();
    await expect(canvas.getByText('主版本')).toBeInTheDocument();
  },
};

export const DarkDenied: Story = {
  args: { initialState: { status: 'error', message: messages.en.denied } },
  globals: { theme: 'dark' },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  render: args => <CreateWorkReceipt messages={args.messages} receipt={receipt} title="Notes on a City of Rivers" />,
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
