import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, screen, waitFor } from 'storybook/test';
import { useState, type ComponentProps } from 'react';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { agents } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { NewWorkForm } from './new-work-form.tsx';
import { StudioFrame } from './studio-frame.tsx';
import { chooseOption } from '../stories/choose-option.ts';
import { createdWorkPath } from './agent.ts';

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

const destination = `/en${createdWorkPath(agents[0]!, '00000000-0000-4000-8000-000000000001', 'recipe', 'en')}`;
const navigate = fn();
const accepted = fn(async () => ({ status: 'created' as const, key: 'new-work-story', href: destination,
  values: { title: 'Tomato soup', type: 'https://schema.org/Recipe', language: 'en' } }));

function CreationNavigation(args: ComponentProps<typeof NewWorkForm>) {
  const [pathname, setPathname] = useState('/en/studio/@111111114bZ6BZRUqUqZep/new');
  return <StoryRouteContext value={{ pathname, onPush: href => { navigate(href); setPathname(href); } }}>
    <StudioFrame agent={args.agent} agents={agents} session={args.agent} path="new"
      locale={args.locale} messages={args.messages}><NewWorkForm {...args} /></StudioFrame>
  </StoryRouteContext>;
}

export const OpensCreatedRecipe: Story = {
  args: { action: accepted },
  render: args => <CreationNavigation {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Title' }), 'Tomato soup');
    await userEvent.click(canvas.getByText('Recipe', { exact: true }));
    await userEvent.click(canvas.getByRole('combobox', { name: 'Language you’ll write in' }));
    await chooseOption(screen, 'English');
    await userEvent.click(canvas.getByRole('button', { name: /^Create as / }));
    await expect(accepted).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(destination));
    await expect(canvas.getByRole('textbox', { name: 'Title' })).toHaveValue('Tomato soup');
    await expect(canvas.getByRole('radio', { name: /^Recipe/ })).toBeChecked();
    await expect(canvas.getByRole('combobox', { name: 'Language you’ll write in' })).toHaveTextContent('English');
    await expect(canvas.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await expect(navigate).toHaveBeenCalledTimes(1);
  },
};
