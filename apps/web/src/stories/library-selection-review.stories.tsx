import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, libraryEntriesReady, pagePaths } from './page';
import { setLibraryEntriesStoryMode } from '../kernel/fake/library-entries-story';

const meta = {
  title: 'Pages/Library/Selection review',
  parameters: { layout: 'fullscreen' },
  beforeEach: () => setLibraryEntriesStoryMode('recorded'),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function selectedReview(context: { canvasElement: HTMLElement }, unavailable = false) {
  await libraryEntriesReady(context);
  const canvas = within(context.canvasElement);
  const selectPage = await canvas.findByRole('button', { name: m.library_selection_page() });
  await waitFor(() => expect(selectPage).toBeEnabled());
  await userEvent.click(selectPage);
  const tray = await canvas.findByRole('region', { name: m.library_selection_heading() });
  await expect(tray).toBeVisible();
  await expect(tray).toHaveTextContent(m.library_selection_count({ count: 5 }));
  await userEvent.click(within(tray).getByRole('button', { name: m.library_selection_review() }));
  const dialog = await within(document.body).findByRole('dialog', { name: m.library_selection_review_title() });
  await expect(dialog.querySelectorAll('[data-selection-review-entry]')).toHaveLength(5);
  if (unavailable) {
    await expect(within(dialog).getByText(m.library_selection_status_unavailable())).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: m.library_bulk_status_review() })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: m.library_selection_review_close() }));
    await expect(within(tray).getByRole('button', { name: m.library_selection_review() })).toHaveFocus();
    return;
  }
  const state = within(dialog).getByRole('combobox', { name: m.library_selection_state() });
  await expect(state).toBeEnabled();
  const chosen = state.querySelector<HTMLOptionElement>('option[value]:not([value=""])');
  if (!chosen) throw new Error('The selected rows have no common status choice.');
  await userEvent.selectOptions(state, chosen.value);
  await expect(dialog).toHaveTextContent(
    m.library_bulk_status_review_summary({ count: 5, status: chosen.textContent ?? chosen.value }),
  );
  await expect(within(dialog).getByRole('button', { name: m.library_bulk_status_review() })).toBeEnabled();
  await userEvent.click(within(dialog).getByRole('button', { name: m.library_selection_review_close() }));
  await expect(within(tray).getByRole('button', { name: m.library_selection_review() })).toHaveFocus();
}

export const PhoneLight: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: (context) => selectedReview(context),
};
export const PhoneDark: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: (context) => selectedReview(context),
};
export const DesktopLight: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: (context) => selectedReview(context),
};
export const DesktopDark: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: (context) => selectedReview(context),
};

const unavailableVisit = {
  parameters: { admitted: ['personal_library', 'reading_progress', 'library_label.list', 'library_label.assign'] },
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
  play: (context: Parameters<typeof selectedReview>[0]) => selectedReview(context, true),
};

export const StatusUnavailablePhoneLight: Story = {
  ...unavailableVisit,
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
};
export const StatusUnavailablePhoneDark: Story = {
  ...unavailableVisit,
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
};
export const StatusUnavailableDesktopLight: Story = {
  ...unavailableVisit,
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
};
export const StatusUnavailableDesktopDark: Story = {
  ...unavailableVisit,
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
};
