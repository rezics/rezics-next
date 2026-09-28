import { Card, CardContent } from '@rezics/ui/card';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PageContainer } from '../shell/page.tsx';
import { HandleField, type HandleAvailability } from './handle-field.tsx';
import { messages } from './messages.ts';

const available = async (): Promise<HandleAvailability> => 'available';
const taken = async (): Promise<HandleAvailability> => 'taken';
const meta = { title: 'Onboarding/Choose handle', component: HandleField,
  args: { action: '/en/onboarding/finish', initial: 'ada_lovelace', submit: messages.en.continue,
    messages: messages.en, checkAvailability: available,
    children: <div className="grid gap-1 rounded-lg border border-border bg-muted/40 p-4">
      <span className="text-muted-foreground text-sm">{messages.en.displayName}</span>
      <strong>Ada Lovelace</strong>
      <span className="text-muted-foreground text-sm">{messages.en.displayNameHelp}</span>
    </div> },
  decorators: [(Story, context) => {
    const t = context.globals.locale === 'zh-Hans' ? messages['zh-Hans'] : messages.en;
    return <PageContainer className="max-w-xl py-8 sm:py-16"><Card><CardContent
    className="grid gap-6 p-6 sm:p-8"><header className="grid gap-2">
      <h1 className="font-semibold text-2xl">{t.welcome}</h1>
      <p className="text-muted-foreground">{t.welcomeHelp}</p>
    </header><Story /><p className="text-muted-foreground text-sm">{t.topicsLater}</p>
    </CardContent></Card></PageContainer>;
  }],
} satisfies Meta<typeof HandleField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('available'));
    await expect(canvas.getByRole('button', { name: 'Continue' })).toBeEnabled();
  },
};

export const AlreadyTaken: Story = {
  args: { checkAvailability: taken },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('already in use'));
    await expect(canvas.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Your handle' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Your handle' }), 'ab');
    await expect(canvas.getByRole('status')).toHaveTextContent('3–30');
  },
};

export const Chinese: Story = {
  args: { messages: messages['zh-Hans'], submit: messages['zh-Hans'].continue,
    children: <div className="grid gap-1 rounded-lg border border-border bg-muted/40 p-4">
      <span className="text-muted-foreground text-sm">{messages['zh-Hans'].displayName}</span>
      <strong>Ada Lovelace</strong>
      <span className="text-muted-foreground text-sm">{messages['zh-Hans'].displayNameHelp}</span>
    </div> },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: '您的用户名' })).toHaveValue('ada_lovelace');
    await waitFor(() => expect(canvas.getByRole('button', { name: '继续' })).toBeEnabled());
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
