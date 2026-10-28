import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withSurface } from '../stories/support.tsx';
import { applyReactionChange, Reactions, type ReactionKind } from './reactions.tsx';

const meta = {
  title: 'Rezics UI/Reactions',
  component: Reactions,
  tags: ['autodocs'],
  args: {
    counts: { upvote: 3, like: 12 },
    value: null,
    locale: 'en',
    onChange: async () => {},
  },
  parameters: {
    docs: {
      description: {
        component:
          'One reaction slot on a thread or post. Counts render as icon chips, and React opens every kind. Choosing a kind replaces the current one; choosing it again clears it. The row updates at once and rolls back, with an announced message, when saving fails. A signed-out viewer sees read-only chips and a link to sign in. Pressed text uses ink blue.',
      },
    },
  },
  decorators: [withSurface],
} satisfies Meta<typeof Reactions>;
export default meta;
type Story = StoryObj<typeof meta>;

const kindNames = ['Upvote', 'Downvote', 'Like', 'Love', 'Laugh', 'Insightful', 'Sad'] as const;

function PendingReactions({
  initialValue,
  initialCounts,
}: {
  initialValue: ReactionKind | null;
  initialCounts: Partial<Record<ReactionKind, number>>;
}) {
  const [value, setValue] = React.useState(initialValue);
  const [counts, setCounts] = React.useState(initialCounts);
  const [started, setStarted] = React.useState(0);
  const valueRef = React.useRef(initialValue);
  const releases = React.useRef<Array<() => void>>([]);

  return (
    <div className="flex flex-col items-start gap-3">
      <Reactions
        counts={counts}
        locale="en"
        onChange={(kind) => {
          setStarted((count) => count + 1);
          return new Promise((resolve) => {
            releases.current.push(() => {
              // Read the previous kind now: React may run the updater after the ref moves on.
              const previous = valueRef.current;
              setCounts((current) => applyReactionChange(current, previous, kind));
              valueRef.current = kind;
              setValue(kind);
              resolve();
            });
          });
        }}
        value={value}
      />
      <button onClick={() => releases.current.shift()?.()} type="button">
        Confirm reaction
      </button>
      <p aria-label={`${started} changes started`} role="status">
        {started} changes started
      </p>
    </div>
  );
}

function RejectingReactions() {
  const rejectRef = React.useRef<((reason: unknown) => void) | null>(null);

  return (
    <div className="flex flex-col items-start gap-3">
      <Reactions
        counts={{ like: 4, love: 2 }}
        locale="en"
        onChange={() =>
          new Promise((_, reject) => {
            rejectRef.current = reject;
          })
        }
        value="love"
      />
      <button onClick={() => rejectRef.current?.(new Error('offline'))} type="button">
        Reject reaction
      </button>
    </div>
  );
}

const dialog = () => screen.queryByRole('dialog') ?? screen.getByRole('menu');

const openChoices = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'React' }));
  await waitFor(() => expect(screen.queryByRole('dialog') ?? screen.queryByRole('menu')).not.toBeNull());
  return settled(dialog());
};

/** Used color of a token, resolved the same way the pressed control resolves it. */
function usedColor(element: HTMLElement, token: '--primary' | '--brand'): string {
  const probe = element.ownerDocument.createElement('span');
  probe.style.color = `var(${token})`;
  element.ownerDocument.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

async function expectInkBlue(element: HTMLElement) {
  const text = getComputedStyle(element).color;
  await expect(text).toBe(usedColor(element, '--primary'));
  await expect(text).not.toBe(usedColor(element, '--brand'));
}

export const ChooseReaction: Story = {
  render: () => <PendingReactions initialCounts={{ upvote: 8 }} initialValue={null} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const choices = await openChoices(canvasElement);
    for (const name of kindNames) await expect(within(choices).getByRole('button', { name })).toBeVisible();
    await userEvent.click(within(choices).getByRole('button', { name: 'Like' }));
    const like = await canvas.findByRole('button', { name: 'Like 1' });
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: 'Upvote 8' })).toHaveAttribute('aria-pressed', 'false');
    await expect(within(dialog()).getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('status', { name: '1 changes started' })).toBeVisible();
    await expectInkBlue(canvas.getByRole('button', { name: 'Like 1' }));
    await expectInkBlue(within(dialog()).getByRole('button', { name: 'Like' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm reaction' }));
    await expect(canvas.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'true');
  },
};
export const MenuOpenPhone: Story = {
  render: () => <PendingReactions initialCounts={{ upvote: 8 }} initialValue={null} />,
  parameters: { viewport: { defaultViewport: 'phone' } },
  async play({ canvasElement }) {
    const choices = await openChoices(canvasElement);
    await expect(within(choices).getByRole('button', { name: 'Like' })).toBeVisible();
  },
};

export const ReplaceReaction: Story = {
  render: () => <PendingReactions initialCounts={{ like: 2, love: 5 }} initialValue="like" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const choices = await openChoices(canvasElement);
    await userEvent.click(within(choices).getByRole('button', { name: 'Love' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Love 6' })).toHaveAttribute('aria-pressed', 'true'));
    await expect(canvas.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.getByRole('status', { name: '1 changes started' })).toBeVisible();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Upvote' }));
    await expect(canvas.getByRole('status', { name: '1 changes started' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Upvote 1' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm reaction' }));
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Upvote 1' })).toHaveAttribute('aria-pressed', 'true'),
    );
    await expect(canvas.getByRole('status', { name: '2 changes started' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Love 5' })).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');
    await expect(within(dialog()).getByRole('button', { name: 'Upvote' })).toHaveAttribute('aria-pressed', 'true');
    await expect(within(dialog()).getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm reaction' }));
    await expect(canvas.getByRole('button', { name: 'Upvote 1' })).toHaveAttribute('aria-pressed', 'true');
  },
};

export const ClearReaction: Story = {
  render: () => <PendingReactions initialCounts={{ like: 1, upvote: 4 }} initialValue="like" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const choices = await openChoices(canvasElement);
    await expect(within(choices).getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(choices).getByRole('button', { name: 'Like' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Like 1' })).not.toBeInTheDocument());
    await expect(within(dialog()).getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(canvas.getByRole('button', { name: 'Confirm reaction' }));
    await expect(canvas.queryByRole('button', { name: 'Like 1' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Upvote 4' })).toBeVisible();
  },
};

export const CountsInLocale: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <section aria-label="Japanese">
        <Reactions counts={{ insightful: 10000, like: 12000 }} locale="ja" onChange={async () => {}} value={null} />
      </section>
      <section aria-label="German">
        <Reactions counts={{ insightful: 10000, like: 12000 }} locale="de" onChange={async () => {}} value={null} />
      </section>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const japanese = within(canvas.getByRole('region', { name: 'Japanese' }));
    await expect(japanese.getByRole('button', { name: 'Like 1.2万' })).toBeVisible();
    await expect(japanese.getByRole('button', { name: 'Insightful 1万' })).toBeVisible();
    const german = within(canvas.getByRole('region', { name: 'German' }));
    await expect(german.getByRole('button', { name: 'Like 12.000' })).toBeVisible();
    await expect(german.getByRole('button', { name: 'Insightful 10.000' })).toBeVisible();
  },
};

export const SignedOut: Story = {
  args: {
    counts: { like: 12, sad: 3 },
    locale: 'en',
    onChange: async () => {
      throw new Error('signed out');
    },
    signInHref: '/sign-in',
    value: null,
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const link = canvas.getByRole('link', { name: 'React' });
    await expect(link).toHaveAttribute('href', '/sign-in');
    await expect(canvas.getByRole('img', { name: 'Like 12' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Sad 3' })).toBeVisible();
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
};

export const FailedChangeRollsBack: Story = {
  render: () => <RejectingReactions />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Love 2' })).toHaveAttribute('aria-pressed', 'true');
    const choices = await openChoices(canvasElement);
    await userEvent.click(within(choices).getByRole('button', { name: 'Like' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Like 5' })).toHaveAttribute('aria-pressed', 'true'));
    await expect(canvas.getByRole('button', { name: 'Love 1' })).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Reject reaction' }));
    await waitFor(() => expect(canvas.getByRole('status', { name: 'The reaction change failed.' })).toBeVisible());
    await expect(canvas.getByRole('button', { name: 'Love 2' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: 'Like 4' })).toHaveAttribute('aria-pressed', 'false');
    await expect(within(dialog()).getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'true');
    await expect(within(dialog()).getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false');
    await expectInkBlue(canvas.getByRole('button', { name: 'Love 2' }));
  },
};
