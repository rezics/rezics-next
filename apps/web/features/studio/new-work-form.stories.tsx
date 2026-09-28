import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { agents } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { NewWorkForm } from './new-work-form.tsx';
import { StudioFrame } from './studio-frame.tsx';

const meta = {
  title: 'Studio/New Work',
  component: NewWorkForm,
  parameters: { route: { pathname: '/en/studio/@agent-00000000-0000-4000-8000-000000000001/new' } },
  args: { agent: agents[0]!, locale: 'en', messages,
    initialState: { status: 'idle', key: 'new-work-story' },
    action: async previous => previous },
  render: args => <StudioFrame agent={args.agent} agents={agents} session={args.agent} path="new"
    locale={args.locale} messages={args.messages}><NewWorkForm {...args} /></StudioFrame>,
} satisfies Meta<typeof NewWorkForm>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The author must state a language, including an explicit unknown. */
export const LanguageRequired: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const language = canvas.getByRole('combobox', { name: 'Language you’ll write in' }) as HTMLSelectElement;
    await expect(language).toHaveValue('');
    await expect(language.checkValidity()).toBe(false);
    await expect(canvas.getByText('Choose the language of this work, or select Undetermined.')).toBeVisible();
    await userEvent.selectOptions(language, 'und');
    await expect(language.checkValidity()).toBe(true);
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: zhHans } };
