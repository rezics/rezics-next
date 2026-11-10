import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../../../shell/shell';
import { PageHeading } from '../../../shell/page-heading';
import { PatternStory } from '../../page';
import { SpaceSetupForm, type SetupTransport } from './space-setup';
import type { SetupSnapshot, SetupCommand } from '../../../community/space-setup';
import { BoardChoiceUnavailable, type BoardChoiceSource } from '../../../community/setup-board-picker';
import spaceRecording from '../../../kernel/recorded/space.json';
import realmRecording from '../../../kernel/recorded/realm.json';
import { m } from '../../../paraglide/messages.js';

const scheme = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000003', label: 'Reading topics' };
const concept = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000004', label: 'Introductions' };
const initial: SetupSnapshot = {
  kind: 'ready',
  space: {
    id: spaceRecording.space.spaceId,
    head: spaceRecording.space.headRevisionId,
    title: spaceRecording.space.title,
    summary: spaceRecording.space.summary,
    address: spaceRecording.space.address,
    realmId: realmRecording.realm.realmId,
  },
  realm: {
    id: realmRecording.realm.realmId,
    head: realmRecording.realm.headRevisionId,
    title: realmRecording.realm.title,
    summary: realmRecording.realm.summary,
    visibility: 'public',
    contextId: realmRecording.realm.contextId,
    schemeId: scheme.id,
  },
  permitted: { address: true, settings: true, scheme: true, board: true },
};
// Explicit display/command contract fixtures, not a production catalogue or permission source.
const choices: BoardChoiceSource = {
  conceptQuery: 'loaded-page',
  schemes: async ({ query }) => ({
    schemes: scheme.label.toLowerCase().includes(query.toLowerCase()) ? [scheme] : [],
    next: null,
  }),
  concepts: async ({ schemeId }) => {
    if (schemeId !== scheme.id) throw new BoardChoiceUnavailable();
    return { concepts: [concept], next: null };
  },
};
function BoardChoiceExample({ outcome = 'denied' }: { outcome?: 'denied' | 'conflict' | 'unavailable' }) {
  const transport = useMemo<SetupTransport>(() => {
    let first: SetupCommand | null = null;
    return {
      choice: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
      command: async (command) => {
        if (outcome === 'unavailable') {
          if (first) await expect(command).toEqual(first);
          first = command;
        }
        return {
          kind: 'failure',
          reason: outcome,
          status: outcome === 'denied' ? 403 : outcome === 'conflict' ? 409 : 503,
        };
      },
      read: async () =>
        outcome === 'conflict'
          ? { ...initial, realm: { ...initial.realm!, schemeId: '0192f3a0-6c1e-7b2a-9d4e-000000000005' } }
          : { ...initial, permitted: { address: false, settings: false, scheme: false, board: false } },
    };
  }, [outcome]);
  return (
    <PatternStory visitor="Signed In" path="/realms/new">
      <AppShell>
        <article className="mx-auto max-w-5xl space-y-6 text-foreground">
          <PageHeading>{m.space_setup_heading()}</PageHeading>
          <SpaceSetupForm initial={initial} transport={transport} boardChoices={choices} />
        </article>
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Community/Space Setup/Board Choices',
  id: 'patterns-community-space-setup-board-choices',
  component: BoardChoiceExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The existing setup form in AppShell, using explicit BoardChoiceSource display fixtures and native refusal response contracts. Review the same IDs at phone390/desktop1280 in light/dark. These states do not claim installed list availability or native authorization proof.',
      },
    },
  },
} satisfies Meta<typeof BoardChoiceExample>;
export default meta;
type Story = StoryObj<typeof meta>;
const render: NonNullable<Story['render']> = (args) => <BoardChoiceExample {...args} />;
async function chooseTopic(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.click(view.getByRole('button', { name: m.space_setup_board() }));
  await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'Start here');
  await userEvent.click(await view.findByRole('radio', { name: concept.label }));
  return view;
}
export const Selection: Story = {
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_scheme() }));
    await userEvent.type(view.getByRole('searchbox', { name: m.space_setup_scheme_label() }), 'Reading');
    await userEvent.click(await view.findByRole('radio', { name: scheme.label }));
    await expect(view.getByRole('button', { name: m.space_setup_save_scheme() })).toBeEnabled();
    await expect(view.queryByRole('textbox', { name: m.space_setup_reference() })).toBeNull();
  },
};
export const StaleScheme: Story = {
  args: { outcome: 'conflict' },
  render,
  play: async ({ canvasElement }) => {
    const view = await chooseTopic(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_board() }));
    await userEvent.click(await view.findByRole('button', { name: m.space_setup_refresh() }));
    await view.findByText(m.space_setup_board_choice_scheme_changed());
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue('Start here');
    await expect(view.getByRole('button', { name: m.space_setup_create_board() })).toBeDisabled();
  },
};
export const Denied: Story = {
  args: { outcome: 'denied' },
  render,
  play: async ({ canvasElement }) => {
    const view = await chooseTopic(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_board() }));
    await view.findByText(m.space_setup_denied());
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue('Start here');
    await expect(view.queryByText(m.space_setup_complete())).toBeNull();
  },
};
export const UncertainRetry: Story = {
  args: { outcome: 'unavailable' },
  render,
  play: async ({ canvasElement }) => {
    const view = await chooseTopic(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_board() }));
    await userEvent.click(await view.findByRole('button', { name: m.space_setup_retry() }));
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toBeDisabled();
    await expect(view.queryByRole('link', { name: m.space_setup_open_board() })).toBeNull();
  },
};
