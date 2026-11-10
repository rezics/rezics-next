import { useMemo } from 'react';
import { EditorialContextWorkspace } from '../features/catalogue/editorial-context-view';
import { editorialContextFixture } from '../kernel/fake/editorial-context';
import { getLocale } from '../paraglide/runtime';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { EditorialContextStory } from '../features/catalogue/editorial-context-story';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Catalogue/Editorial Context',
  id: 'pages-catalogue-editorial-context',
  component: EditorialContextStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'Named Context lifecycle with generated requests and the existing review workspace. Samples establish no runtime availability, native authority or visual acceptance.',
      },
    },
  },
} satisfies Meta<typeof EditorialContextStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Readers’ choices');
  await userEvent.click(canvas.getByRole('button', { name: m.editorial_create() }));
  return canvas;
}
async function expectPhoneControls(canvasElement: HTMLElement) {
  const workspace = canvasElement.querySelector<HTMLElement>('[data-editorial-workspace]');
  if (!workspace) throw new Error('Editorial Context workspace was not rendered');
  const bounds = workspace.getBoundingClientRect();
  await expect(bounds.width).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
  const form = workspace.querySelector<HTMLElement>('[data-editorial-form]');
  if (form) await expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
  for (const row of workspace.querySelectorAll<HTMLElement>('[data-editorial-action-row]')) {
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  }
  const controls = workspace.querySelectorAll<HTMLElement>('[data-editorial-control]');
  await expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    await expect(control).toBeVisible();
    await expect(rect.width).toBeGreaterThanOrEqual(44);
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
    await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    await expect(control.scrollHeight).toBeLessThanOrEqual(control.clientHeight + 1);
  }
}
async function remove(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.editorial_delete() }));
  await canvas.findByText(m.editorial_confirm_delete());
  await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
  return canvas;
}
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
    await canvas.findByText(m.context_inherited());
  },
};
export const Empty: Story = { args: { scenario: 'create' } };
export const Created: Story = {
  args: { scenario: 'create' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole('textbox', { name: m.catalogue_create_label() });
    await expectPhoneControls(canvasElement);
    const canvas = await create(canvasElement);
    await canvas.findByText(m.editorial_created());
    expect(await canvas.findByRole('link', { name: m.editorial_review() })).toHaveAttribute(
      'href',
      expect.stringContaining('/context-review?context='),
    );
    await expectPhoneControls(canvasElement);
  },
};
export const Deleted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const deleteButton = await canvas.findByRole('button', { name: m.editorial_delete() });
    await expectPhoneControls(canvasElement);
    await userEvent.click(deleteButton);
    await canvas.findByText(m.editorial_confirm_delete());
    await expectPhoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_cancel() }));
    await expect(canvas.queryByText(m.editorial_confirm_delete())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.editorial_delete() }));
    await canvas.findByText(m.editorial_confirm_delete());
    const confirmButton = canvas.getByRole('button', { name: m.contribution_confirm() });
    const cancelButton = canvas.getByRole('button', { name: m.candidate_cancel() });
    await expectPhoneControls(canvasElement);
    await userEvent.tab();
    await expect(cancelButton).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(confirmButton).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.editorial_deleted());
    expect(canvas.queryByRole('button', { name: m.candidate_entry() })).toBeNull();
    expect(canvas.queryByRole('link', { name: m.editorial_review() })).toBeNull();
    await canvas.findByRole('button', { name: m.editorial_restore() });
    await expectPhoneControls(canvasElement);
  },
};
export const Restored: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await remove(canvasElement);
    await expectPhoneControls(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.editorial_restore() }));
    await canvas.findByText(m.editorial_confirm_restore());
    await expectPhoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
    await canvas.findByText(m.editorial_restored());
    await canvas.findByRole('link', { name: m.editorial_review() });
    await expectPhoneControls(canvasElement);
  },
};
export const Global: Story = {
  args: { scenario: 'global' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.editorial_global());
    expect(canvas.queryByRole('button', { name: m.editorial_delete() })).toBeNull();
  },
};
export const Denied: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = await remove(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_denied());
    expect(canvas.queryByRole('button', { name: m.editorial_restore() })).toBeNull();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_invalid());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Readers’ choices');
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_conflict());
    await expectPhoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.editorial_revise() }));
    await expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Readers’ choices');
    await expectPhoneControls(canvasElement);
  },
};
export const Expired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    const canvas = await remove(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.editorial_restore() }));
    await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_conflict());
    expect(canvas.queryByRole('link', { name: m.editorial_review() })).toBeNull();
  },
};
export const Concealed: Story = {
  args: { scenario: 'missing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.editorial_missing());
    expect(canvas.queryByRole('button', { name: m.editorial_restore() })).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.editorial_unavailable());
    await expectPhoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByRole('button', { name: m.editorial_delete() });
    await expectPhoneControls(canvasElement);
  },
};
export const RetrySameCreation: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await create(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_unavailable());
    expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
    expect(canvas.queryByRole('button', { name: m.editorial_revise() })).toBeNull();
    await expectPhoneControls(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.editorial_retry() }));
    await canvas.findByText(m.editorial_created());
    await expectPhoneControls(canvasElement);
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };

// Authored UNRUN: independent real workspaces, using the original isolated request fixture.
function IndependentWorkspaces() {
  const locale = getLocale();
  const fixtures = useMemo(
    () => [editorialContextFixture('create', locale), editorialContextFixture('create', locale)],
    [locale],
  );
  return (
    <article className="mx-auto max-w-4xl space-y-8 p-4 sm:p-8">
      {fixtures.map((fixture, index) => (
        <EditorialContextWorkspace key={index} locale={locale} transport={fixture.transport} />
      ))}
    </article>
  );
}
async function independentWorkspaceJourney(canvasElement: HTMLElement) {
  const workspaces = canvasElement.querySelectorAll<HTMLElement>('[data-editorial-workspace]');
  await expect(workspaces).toHaveLength(2);
  const [first, second] = [...workspaces];
  const inputs = [...canvasElement.querySelectorAll<HTMLInputElement>('input[data-editorial-control]')];
  await expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
  for (const workspace of workspaces) {
    await expect(workspace.querySelector('[data-editorial-panel]')).toHaveClass('group');
    await expect(within(workspace).getByRole('heading', { level: 2 })).toHaveTextContent(m.editorial_title());
    for (const label of workspace.querySelectorAll<HTMLLabelElement>('label')) {
      await expect(workspace.querySelector(`[id="${label.htmlFor}"]`)).not.toBeNull();
    }
  }
  const longName = '読者の選択 — Gemeinschaft für gemeinsame Lektüre et les récits partagés '.repeat(3);
  await userEvent.type(inputs[0]!, longName);
  await expect(inputs[1]!).toHaveValue('');
  await userEvent.selectOptions(within(first!).getByRole('combobox', { name: m.catalogue_create_language() }), 'ja');
  await expect(second!.querySelector('select')).toHaveValue(getLocale());
  await userEvent.click(within(first!).getByRole('button', { name: m.editorial_create() }));
  await within(first!).findByText(m.editorial_created());
  await expect(within(first!).getByRole('heading', { level: 2 })).toHaveTextContent(longName.trim());
  await expect(inputs[1]!).toHaveValue('');
  await expect(within(second!).queryByText(m.editorial_created())).toBeNull();
  for (const workspace of workspaces) {
    const bounds = workspace.getBoundingClientRect();
    await expect(bounds.width).toBeLessThanOrEqual(canvasElement.ownerDocument.documentElement.clientWidth);
    await expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1);
    for (const control of workspace.querySelectorAll<HTMLElement>('[data-editorial-control]')) {
      const rect = control.getBoundingClientRect();
      await expect(control).toBeVisible();
      await expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(rect.height).toBeGreaterThanOrEqual(44);
      await expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
      await expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
      await expect(control.scrollHeight).toBeLessThanOrEqual(control.clientHeight + 1);
    }
  }
}
export const IndependentWorkspaceJourney: Story = {
  render: () => <IndependentWorkspaces />,
  play: async ({ canvasElement }) => independentWorkspaceJourney(canvasElement),
};
export const IndependentWorkspacesRtl: Story = {
  render: () => (
    <div dir="rtl">
      <IndependentWorkspaces />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const workspaces = canvasElement.querySelectorAll<HTMLElement>('[data-editorial-workspace]');
    await expect(workspaces).toHaveLength(2);
    for (const workspace of workspaces) {
      await expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1);
      const select = within(workspace).getByRole('combobox', { name: m.catalogue_create_language() });
      await userEvent.click(select);
      await userEvent.tab();
      await expect(workspace.querySelector('input')).toHaveFocus();
      await userEvent.tab({ shift: true });
      await expect(select).toHaveFocus();
    }
  },
};
