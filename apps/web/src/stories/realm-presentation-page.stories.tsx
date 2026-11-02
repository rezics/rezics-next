import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PageStory } from './page';
import { appearancePath } from '../kernel/fake/community';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Community/Realm Appearance', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Management: Story = {
  render: () => <PageStory visitor="Signed In" path={appearancePath} />,
  play: async ({ canvasElement }) => {
    const main = await within(canvasElement).findByRole('main');
    await userEvent.click(await within(main).findByRole('button', { name: m.community_manage() }));
    await expect(await within(main).findByRole('heading', { name: m.realm_appearance_heading() })).toBeVisible();
    await expect(await within(main).findByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();
  },
};

/** The production page keeps cancel and refresh local to the admitted management region. */
export const ManagementInteractions: Story = {
  render: () => <PageStory visitor="Signed In" path={appearancePath} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = await canvas.findByRole('main');
    await expect(canvas.getAllByRole('main')).toHaveLength(1);
    const page = within(main);
    await expect(page.queryByText(m.realm_claim_owned())).toBeNull();
    await userEvent.click(await page.findByRole('button', { name: m.community_manage() }));
    const appearance = within(await page.findByRole('region', { name: m.realm_appearance_heading() }));
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();
    await expect(appearance.getByText('A thoughtful reading room')).toBeVisible();

    const selectRules = appearance.getByRole('button', { name: m.realm_appearance_select_rules() });
    selectRules.focus();
    await userEvent.keyboard('{Enter}');
    await appearance.findByRole('textbox', { name: m.realm_appearance_rules_link() });
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeDisabled();
    await userEvent.click(page.getByRole('button', { name: m.community_manage_close() }));
    await expect(page.queryByRole('region', { name: m.realm_appearance_heading() })).toBeNull();
    await userEvent.click(page.getByRole('button', { name: m.community_manage() }));
    await expect(appearance.getByRole('textbox', { name: m.realm_appearance_rules_link() })).toBeVisible();
    await userEvent.click(appearance.getByRole('button', { name: m.editor_cancel() }));
    await expect(appearance.queryByRole('textbox', { name: m.realm_appearance_rules_link() })).toBeNull();

    await userEvent.click(appearance.getAllByRole('button', { name: m.realm_appearance_clear() })[0]!);
    const confirmation = within(appearance.getByRole('group', { name: m.realm_appearance_clear_confirm() }));
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeDisabled();
    await userEvent.click(confirmation.getByRole('button', { name: m.editor_cancel() }));
    await expect(appearance.queryByRole('group', { name: m.realm_appearance_clear_confirm() })).toBeNull();
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();

    await userEvent.click(appearance.getByRole('button', { name: m.realm_appearance_refresh() }));
    await expect(await appearance.findByRole('button', { name: m.realm_appearance_refresh() })).toBeEnabled();
    await expect(await page.findByRole('region', { name: m.realm_appearance_heading() })).toBeVisible();
  },
};

/** The default Panel waits for a ready signed-in session and keeps private management controls hidden otherwise. */
export const SignedOutManagement: Story = {
  render: () => <PageStory visitor="Signed Out" path={appearancePath} />,
  play: async ({ canvasElement }) => {
    const main = await within(canvasElement).findByRole('main');
    await expect(within(main).queryByRole('region', { name: m.realm_appearance_heading() })).toBeNull();
  },
};
