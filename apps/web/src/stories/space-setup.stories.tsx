import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SpaceSetupForm, emptySetup, type SetupTransport } from '../community/space-setup-form';
import type { SetupSnapshot } from '../community/space-setup';
import spaceRecording from '../kernel/recorded/space.json';
import realmRecording from '../kernel/recorded/realm.json';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Community/Space Setup',
  component: SpaceSetupForm,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Space setup saves each ordinary command independently. Existing Context and SKOS IDs are resolved before selection. Membership and Context authority remain separate. Draft fields survive current-head refresh; uncertain requests replay their original body and key. These transport-boundary stories cover interaction states, not native authorization proof. Review the same IDs with phone390/desktop1280, locale and theme globals. Pages reuse this pattern. Postintegration acceptance and Web/Root visual review are pending.',
      },
    },
  },
} satisfies Meta<typeof SpaceSetupForm>;
export default meta;
type Story = StoryObj<typeof meta>;
const recorded: SetupSnapshot = {
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
    schemeId: null,
  },
  permitted: { address: true, settings: true, scheme: true, board: true },
};
function boundary(status: 403 | 412 | 503, current = emptySetup): SetupTransport {
  return {
    command: async () => ({
      kind: 'failure',
      status,
      reason: status === 403 ? 'denied' : status === 412 ? 'conflict' : 'unavailable',
    }),
    read: async () => current,
    choice: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
  };
}
const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path="/realms/new">
    <div className="p-4 sm:p-8">
      <SpaceSetupForm {...args} />
    </div>
  </PatternStory>
);
export const Rest: Story = { args: { initial: emptySetup, transport: boundary(503) }, render };
export const EnteredData: Story = {
  args: Rest.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.type(
      view.getByRole('textbox', { name: m.space_setup_summary() }),
      'A place for slow novels and thoughtful discussion.',
    );
    await expect(view.getByRole('button', { name: m.space_setup_create_space() })).toBeEnabled();
  },
};
export const RetryPreservesWork: Story = {
  args: Rest.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_space() }));
    await userEvent.click(await view.findByRole('button', { name: m.space_setup_retry() }));
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toHaveValue('The Evening Reading Room');
    await expect(view.getByRole('textbox', { name: m.space_setup_title() })).toBeDisabled();
  },
};
export const ConfiguredRealm: Story = { args: { initial: recorded, transport: boundary(503, recorded) }, render };
export const HeadConflict: Story = {
  args: {
    initial: recorded,
    transport: boundary(412, {
      ...recorded,
      space: recorded.space && { ...recorded.space, head: realmRecording.realm.headRevisionId },
    }),
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const address = view.getByRole('textbox', { name: m.space_setup_address() });
    await userEvent.clear(address);
    await userEvent.type(address, 'evening-reading-room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_address() }));
    await view.findByText(m.space_setup_conflict());
    await userEvent.click(view.getByRole('button', { name: m.space_setup_refresh() }));
    await expect(address).toHaveValue('evening-reading-room');
    await expect(view.getByRole('link', { name: m.space_setup_home() })).toBeVisible();
  },
};
export const CurrentAuthorityRefused: Story = {
  args: { initial: recorded, transport: boundary(403, recorded) },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_save_address() }));
    await view.findByText(m.space_setup_denied());
    await expect(view.queryByText(m.space_setup_complete())).toBeNull();
  },
};
export const Unavailable: Story = {
  args: {
    initial: { kind: 'failure', reason: 'unavailable', status: 503 },
    transport: {
      ...boundary(503),
      read: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
    },
  },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.space_setup_refresh() }));
    await view.findByText(m.space_setup_unavailable());
  },
};

export const Saving: Story = {
  args: { initial: emptySetup, transport: { ...boundary(503), command: () => new Promise(() => {}) } },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox', { name: m.space_setup_title() }), 'The Evening Reading Room');
    await userEvent.click(view.getByRole('button', { name: m.space_setup_create_space() }));
    await view.findByRole('status');
    await expect(view.getByRole('button', { name: m.space_setup_create_space() })).toBeDisabled();
  },
};
export const SelectionUnavailable: Story = {
  args: ConfiguredRealm.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const context = view.getByRole('textbox', { name: m.space_setup_context() });
    const field = context.closest('[data-slot="field"]');
    if (!(field instanceof HTMLElement)) throw new Error('Context field is missing');
    await userEvent.click(within(field).getByRole('button', { name: m.space_setup_resolve() }));
    await within(field).findByRole('alert');
    await expect(view.getByRole('button', { name: m.space_setup_save_settings() })).toBeDisabled();
  },
};
