import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmAppearanceSettings } from '../community/realm-presentation-settings';
import type { RealmAppearanceAdapter, RealmAppearanceCommand } from '../community/realm-presentation';
import { available, configured, fixtureAdapter, imageId, revisionId } from './patterns/realm-presentation/fixtures';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Patterns/Community/Realm Appearance Settings',
  component: RealmAppearanceSettings,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual reusable management Pattern with explicit future-native fixtures. Production currently reports unavailable. Review these IDs with the existing phone390/desktop1280, locale and theme globals. These examples do not establish native privacy, lifecycle, image availability or visual acceptance.',
      },
    },
  },
} satisfies Meta<typeof RealmAppearanceSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
const render: NonNullable<Story['render']> = (args) => (
  <PatternStory visitor="Signed In" path={`/realms/${configured.realmId}`}>
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <RealmAppearanceSettings {...args} />
    </div>
  </PatternStory>
);
export const Manage: Story = {
  args: { realmId: configured.realmId, initial: { kind: 'ready', snapshot: configured }, adapter: fixtureAdapter() },
  render,
};
export const Available: Story = {
  args: { ...Manage.args, initial: { kind: 'ready', snapshot: available }, adapter: fixtureAdapter(available) },
  render,
};
export const Readonly: Story = {
  args: { ...Available.args, initial: { kind: 'ready', snapshot: { ...available, canManage: false } } },
  render,
};
export const Cleared: Story = { ...Manage };
export const Unavailable: Story = { args: { ...Manage.args, initial: { kind: 'unavailable' } }, render };
export const OptionalUnavailable: Story = {
  args: {
    ...Manage.args,
    initial: {
      kind: 'ready',
      snapshot: {
        ...configured,
        avatar: { state: 'unavailable', value: null },
        banner: { state: 'unavailable', value: null },
        rules: { state: 'unavailable', value: null },
      },
    },
  },
  render,
};
export const Uploading: Story = {
  args: { ...Manage.args, adapter: { ...fixtureAdapter(), upload: () => new Promise(() => {}) } },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.upload(
      view.getByLabelText(`${m.realm_appearance_icon()}: ${m.realm_appearance_upload()}`),
      new File(['image'], 'icon.png', { type: 'image/png' }),
    );
    await view.findByText(m.realm_appearance_uploading());
    await expect(view.getByRole('button', { name: m.realm_appearance_save() })).toBeDisabled();
  },
};
export const Conflict: Story = {
  args: { ...Available.args, adapter: { ...fixtureAdapter(available), change: async () => ({ kind: 'conflict' }) } },
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_save() }));
    await view.findByText(m.realm_appearance_conflict());
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_refresh() }));
    await view.findByRole('button', { name: m.realm_appearance_review() });
  },
};
function RetryExample() {
  let first: RealmAppearanceCommand | null = null;
  const adapter: RealmAppearanceAdapter = {
    ...fixtureAdapter(),
    change: async (command: RealmAppearanceCommand) => {
      if (!first) {
        first = structuredClone(command);
        return { kind: 'unavailable' };
      }
      await expect(command).toEqual(first);
      return fixtureAdapter().change(command);
    },
  };
  return (
    <PatternStory visitor="Signed In" path={`/realms/${configured.realmId}`}>
      <div className="mx-auto max-w-5xl p-4 sm:p-8">
        <RealmAppearanceSettings
          realmId={configured.realmId}
          initial={{ kind: 'ready', snapshot: configured }}
          adapter={adapter}
        />
      </div>
    </PatternStory>
  );
}
export const UncertainRetry: Story = {
  args: Manage.args,
  render: () => <RetryExample />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_select_rules() }));
    await userEvent.type(view.getByRole('textbox', { name: m.realm_appearance_post_id() }), imageId);
    await userEvent.type(view.getByRole('textbox', { name: m.realm_appearance_revision_id() }), revisionId);
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    await userEvent.click(await view.findByRole('button', { name: m.realm_appearance_use_selection() }));
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_save() }));
    await view.findByText(m.realm_appearance_uncertain());
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_retry() }));
    await view.findByText(m.realm_appearance_saved());
    await expect(view.getByText('A thoughtful reading room')).toBeVisible();
  },
};
export const SelectionCancelled: Story = {
  args: Manage.args,
  render,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getAllByRole('button', { name: m.realm_appearance_choose() })[0]!);
    await userEvent.type(view.getByRole('textbox', { name: m.realm_appearance_media_id() }), imageId);
    await userEvent.click(view.getByRole('button', { name: m.realm_appearance_preview() }));
    await view.findByRole('button', { name: m.realm_appearance_use_selection() });
    await userEvent.click(view.getByRole('button', { name: m.editor_cancel() }));
    await expect(view.getAllByText(m.realm_appearance_no_image())).toHaveLength(2);
  },
};
