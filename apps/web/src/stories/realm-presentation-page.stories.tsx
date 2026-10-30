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
    await page.findByText(m.realm_claim_owned());
    const appearance = within(await page.findByRole('region', { name: m.realm_appearance_heading() }));
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();
    await expect(appearance.getByText('A thoughtful reading room')).toBeVisible();

    const selectRules = appearance.getByRole('button', { name: m.realm_appearance_select_rules() });
    selectRules.focus();
    await userEvent.keyboard('{Enter}');
    await appearance.findByRole('textbox', { name: m.realm_appearance_post_id() });
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeDisabled();
    await userEvent.click(appearance.getByRole('button', { name: m.editor_cancel() }));
    await expect(appearance.queryByRole('textbox', { name: m.realm_appearance_post_id() })).toBeNull();

    await userEvent.click(appearance.getAllByRole('button', { name: m.realm_appearance_clear() })[0]!);
    const confirmation = within(appearance.getByRole('group', { name: m.realm_appearance_clear_confirm() }));
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeDisabled();
    await userEvent.click(confirmation.getByRole('button', { name: m.editor_cancel() }));
    await expect(appearance.queryByRole('group', { name: m.realm_appearance_clear_confirm() })).toBeNull();
    await expect(appearance.getByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();

    await userEvent.click(page.getByRole('button', { name: m.realm_claim_refresh() }));
    await expect(await page.findByRole('button', { name: m.realm_claim_refresh() })).toBeEnabled();
    await page.findByText(m.realm_claim_owned());
    await expect(await page.findByRole('region', { name: m.realm_appearance_heading() })).toBeVisible();
  },
};
