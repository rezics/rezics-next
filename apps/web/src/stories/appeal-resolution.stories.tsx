import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppealResolution, type ResolveAppeal } from '../moderation/appeal-resolution';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Moderation/Appeal Resolution',
  id: 'patterns-appeal-resolution',
  component: AppealResolution,
  tags: ['autodocs'],
  args: { appealId: '0192f3a0-6c1e-7b2a-9d4e-000000000001', mayResolve: true },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In">
        <div className="w-full max-w-3xl p-4">
          <Story />
        </div>
      </PatternStory>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'One private form freezes its statement, outcome and command UUID before sending. A lost response locks edits and both outcomes, offering only explicit exact retry. Viewer/session, appeal or admission loss retires the view and fences late results. Confirmed outcomes survive unrelated refresh failures. Refusals and conflicts require a fresh authorized page read. Review these same states using phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta<typeof AppealResolution>;
export default meta;
type Story = StoryObj<typeof meta>;

const success: ResolveAppeal = async ({ outcome, statement }) => ({ state: 'resolved', outcome, statement });
async function enterStatement(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.type(view.getByRole('textbox'), 'Independent review of the original decision.');
  return view;
}

export const Upheld: Story = {
  args: { onResolve: success },
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_uphold_action() }));
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_appeal_upheld());
    await expect(view.getByRole('status')).toHaveTextContent('Independent review of the original decision.');
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Reversed: Story = {
  args: { onResolve: success },
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_reverse_action() }));
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_appeal_reversed());
    await expect(view.getByRole('status')).toHaveTextContent('Independent review of the original decision.');
  },
};

function RetryExample() {
  const [resolve] = useState((): ResolveAppeal => {
    let committed: Parameters<ResolveAppeal>[0] | undefined;
    return async (command) => {
      if (!committed) {
        committed = command;
        throw new Error('Response lost after commit');
      }
      await expect(command).toEqual(committed);
      return { state: 'resolved', outcome: command.outcome, statement: command.statement };
    };
  });
  return <AppealResolution appealId="0192f3a0-6c1e-7b2a-9d4e-000000000001" mayResolve onResolve={resolve} />;
}
export const LostResponseRetry: Story = {
  render: () => <RetryExample />,
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    const reverse = view.getByRole('button', { name: m.moderation_appeal_reverse_action() });
    await userEvent.click(reverse);
    await view.findByRole('alert');
    await expect(view.getByRole('textbox')).toHaveValue('Independent review of the original decision.');
    await expect(view.getByRole('textbox')).toBeDisabled();
    await expect(reverse).toBeDisabled();
    await expect(view.getByRole('button', { name: m.moderation_appeal_uphold_action() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_intent_retry() }));
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_appeal_reversed());
  },
};
export const Pending: Story = {
  args: { onResolve: () => new Promise(() => {}) },
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_uphold_action() }));
    await expect(view.getByRole('textbox')).toBeDisabled();
    await expect(view.getByRole('button', { name: m.moderation_appeal_reverse_action() })).toBeDisabled();
  },
};
export const Forbidden: Story = {
  args: { onResolve: async () => ({ state: 'forbidden' }) },
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_uphold_action() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_appeal_other_moderator());
    await expect(view.queryByRole('status')).toBeNull();
  },
};
export const Conflict: Story = {
  args: { onResolve: async () => ({ state: 'conflict' }) },
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_reverse_action() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_appeal_conflict());
    await expect(view.queryByRole('status')).toBeNull();
  },
};
export const ReadOnly: Story = { args: { mayResolve: false } };

function RetirementExample() {
  const [mayResolve, setMayResolve] = useState(true);
  return (
    <div className="space-y-4">
      <AppealResolution
        appealId="0192f3a0-6c1e-7b2a-9d4e-000000000001"
        mayResolve={mayResolve}
        onResolve={async () => {
          setMayResolve(false);
          return { state: 'resolved', outcome: 'reverse', statement: 'Late private statement' };
        }}
      />
    </div>
  );
}
export const Retired: Story = {
  render: () => <RetirementExample />,
  play: async ({ canvasElement }) => {
    const view = await enterStatement(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_appeal_reverse_action() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_appeal_intent_retired());
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('status')).toBeNull();
  },
};
