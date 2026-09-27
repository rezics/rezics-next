import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './alert.tsx';
import { Button } from './button.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-2xl bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

const meta = {
  title: 'Rezics UI/Feedback/Alert',
  component: Alert,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'An inline, persistent message about the surrounding content: a Work under moderation review, a stale source statistic, a rejected edit or a saved rating. It is not a live region by default; pass `role="alert"` only when the message appears in response to an action and must interrupt. Use Toast for transient confirmations and Alert Dialog when the reader must decide before continuing. Semantic variants color the icon and title with the text-safe tone; the description stays muted.',
      },
    },
  },
} satisfies Meta<typeof Alert>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Alert {...args}>
      <InfoIcon aria-hidden />
      <AlertTitle>Ratings use the Realm context</AlertTitle>
      <AlertDescription>
        Scores on this page come from members of Hard Science Fiction. Switch the context to see the
        site-wide rating.
      </AlertDescription>
    </Alert>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Alert>
        <InfoIcon aria-hidden />
        <AlertTitle>Default</AlertTitle>
        <AlertDescription>Reading positions sync across your devices.</AlertDescription>
      </Alert>
      <Alert variant="info">
        <InfoIcon aria-hidden />
        <AlertTitle>Source statistic</AlertTitle>
        <AlertDescription>
          The Goodreads aggregate is shown separately and never mixed into Rezics ratings.
        </AlertDescription>
      </Alert>
      <Alert variant="success">
        <CircleCheckIcon aria-hidden />
        <AlertTitle>Edit accepted</AlertTitle>
        <AlertDescription>Your correction to the publication year is now live.</AlertDescription>
      </Alert>
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>Statistics may be stale</AlertTitle>
        <AlertDescription>The provider last refreshed this Work 9 days ago.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden />
        <AlertTitle>Edit rejected</AlertTitle>
        <AlertDescription>
          A moderator rejected the new cover: it shows a different edition.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

const onReview = fn();
const onDismiss = fn();

export const WithActions: Story = {
  render: () => (
    <Alert variant="warning">
      <ShieldAlertIcon aria-hidden />
      <AlertTitle>This Work is under moderation review</AlertTitle>
      <AlertDescription>Two members reported the synopsis as containing spoilers.</AlertDescription>
      <AlertAction>
        <Button onClick={onDismiss} size="sm" variant="ghost">
          Dismiss
        </Button>
        <Button onClick={onReview} size="sm" variant="outline">
          Review reports
        </Button>
      </AlertAction>
    </Alert>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Review reports' }));
    await expect(onReview).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    await expect(canvas.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(onDismiss).toHaveBeenCalledOnce();
  },
};

export const Announced: Story = {
  name: 'Announced (role="alert")',
  render: () => (
    <Alert role="alert" variant="destructive">
      <CircleAlertIcon aria-hidden />
      <AlertTitle>Your rating was not saved</AlertTitle>
      <AlertDescription>
        The connection dropped. Your 4-star rating is kept on this device.
      </AlertDescription>
    </Alert>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Your rating was not saved');
  },
};

export const WithoutIcon: Story = {
  render: () => (
    <Alert variant="info">
      <AlertTitle>New in Rezics</AlertTitle>
      <AlertDescription>Shelves can now be shared with a Realm.</AlertDescription>
    </Alert>
  ),
};

export const LongContent: Story = {
  name: 'Long content (zh-CN and mixed)',
  render: () => (
    <div className="flex flex-col gap-4" lang="zh-CN">
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>《三体》的书评区已进入慢速模式</AlertTitle>
        <AlertDescription>
          由于电视剧 3 Body Problem 上线后讨论激增，版主将「硬科幻」Realm 中的每位成员限制为每 10
          分钟发表一条书评。含有剧透的内容请使用剧透标记，否则会被隐藏等待审核。此限制将于 2026 年
          10 月 1 日自动解除。
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline">
            查看规则
          </Button>
        </AlertAction>
      </Alert>
      <Alert>
        <InfoIcon aria-hidden />
        <AlertTitle>
          Imported from Douban: 刘慈欣 · Liu Cixin, The Three-Body Problem (Remembrance of Earth's
          Past, Book 1), Chongqing Publishing Group, 2008
        </AlertTitle>
      </Alert>
    </div>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: Variants.render,
};
