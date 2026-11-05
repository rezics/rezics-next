import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { ContextChoiceError, type ContextChoiceSource } from '../../../community/setup-context-picker';
import { m } from '../../../paraglide/messages.js';
import { AppShell } from '../../../shell/shell';
import { PageHeading } from '../../../shell/page-heading';
import { PatternStory } from '../../page';
import { SpaceSetupForm } from './space-setup';
import { ConfiguredRealm } from './space-setup.stories';

/** Reuses the existing setup boundary; no successful write or invented catalogue is supplied. */
export function ContextSetupReview({
  mode = 'unavailable',
  shell = false,
}: {
  mode?: 'unavailable' | 'denied' | 'loading';
  shell?: boolean;
}) {
  const transport = useMemo(() => {
    const contexts: ContextChoiceSource | undefined =
      mode === 'unavailable'
        ? undefined
        : {
            search: async () => {
              if (mode === 'loading') return new Promise(() => {});
              throw new ContextChoiceError('denied');
            },
            resolve: async () => (mode === 'loading' ? new Promise(() => {}) : null),
          };
    return { ...ConfiguredRealm.args!.transport!, ...(contexts ? { contexts } : {}) };
  }, [mode]);
  const content = (
    <article className="mx-auto max-w-5xl space-y-6 text-foreground">
      <PageHeading>{m.space_setup_heading()}</PageHeading>
      <SpaceSetupForm initial={ConfiguredRealm.args!.initial!} transport={transport} />
    </article>
  );
  return (
    <PatternStory visitor="Signed In" path="/realms/new">
      {shell ? <AppShell>{content}</AppShell> : <div className="p-4 sm:p-8">{content}</div>}
    </PatternStory>
  );
}
const meta = {
  title: 'Patterns/Community/Space Setup Context',
  component: ContextSetupReview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextSetupReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {
  args: { mode: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await userEvent.type(view.getByRole('searchbox', { name: m.space_setup_context_label() }), 'Reading');
    await view.findAllByText(m.setup_context_unavailable());
    await expect(view.queryByText(m.setup_context_empty())).toBeNull();
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), ' draft');
    await expect(view.getByRole('button', { name: m.space_setup_save_settings() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.editor_cancel() }));
    await userEvent.click(view.getByRole('button', { name: m.space_setup_resume() }));
    await expect(view.getByRole('searchbox', { name: m.space_setup_context_label() })).toHaveValue('Reading');
  },
};
export const Denied: Story = {
  args: { mode: 'denied' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await view.findByText(m.setup_context_denied());
    await expect(view.queryByRole('button', { name: m.setup_context_use_current() })).toBeNull();
  },
};
export const Loading: Story = {
  args: { mode: 'loading' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_continue() }));
    await userEvent.type(view.getByRole('searchbox', { name: m.space_setup_context_label() }), 'Reading');
    await view.findByText(m.setup_context_searching());
    await expect(view.queryByText(m.setup_context_empty())).toBeNull();
  },
};
