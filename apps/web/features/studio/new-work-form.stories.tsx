import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, screen } from 'storybook/test';
import { agents } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { NewWorkForm } from './new-work-form.tsx';
import { StudioFrame } from './studio-frame.tsx';
import { chooseOption } from '../stories/choose-option.ts';

const meta = {
  title: 'Studio/New Work',
  component: NewWorkForm,
  parameters: { route: { pathname: '/en/studio/@111111114bZ6BZRUqUqZep/new' } },
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
    const language = canvas.getByRole('combobox', { name: 'Language you’ll write in' });
    await expect(language).toHaveTextContent('Choose a language');
    await expect(canvas.getByText('Choose the language of this work, or select Undetermined.')).toBeVisible();
    await userEvent.click(language);
    await chooseOption(screen, 'Undetermined');
    await expect(language).toHaveTextContent('Undetermined');
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: zhHans } };
