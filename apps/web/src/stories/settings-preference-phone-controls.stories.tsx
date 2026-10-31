import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { notificationRecoveryTransport } from '../kernel/fake/settings-notifications';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

type RequestRecord = { method: string; path: string; search: string; body: string; key: string | null };
const requests: RequestRecord[] = [];
let notificationMode = false;

const meta = {
  title: 'Pages/Account/Settings',
  parameters: { layout: 'fullscreen' },
  beforeEach: () => {
    requests.length = 0;
    notificationMode = false;
    const original = globalThis.fetch;
    const notifications = notificationRecoveryTransport(original);
    // Observe the existing fake kernel; enable its notice recovery scenario after Reading resolves.
    globalThis.fetch = (async (input, init) => {
      const request = new Request(
        input instanceof Request ? input : new URL(String(input), window.location.href),
        init,
      );
      const url = new URL(request.url);
      if (
        url.origin === 'http://kernel.local' &&
        /^\/v1\/(accounts\/[^/]+\/(preferences|collections)|collections\/[^/]+)$/.test(url.pathname)
      ) {
        requests.push({
          method: request.method,
          path: url.pathname,
          search: url.search,
          body: request.method === 'GET' ? '' : await request.clone().text(),
          key: request.headers.get('idempotency-key'),
        });
      }
      return notificationMode ? notifications.fetcher(request) : original(request);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function comfortableControls(region: HTMLElement) {
  const controls = [
    ...region.querySelectorAll<HTMLElement>('[data-slot="button"], [data-slot="native-select"]'),
  ].filter((control) => !control.hidden);
  await expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const style = getComputedStyle(control);
    const bounds = control.getBoundingClientRect();
    await expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeLessThanOrEqual(region.clientWidth);
    await expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    if (control.dataset.slot === 'button') {
      await expect(control).toHaveClass('min-h-11', 'max-w-full', 'whitespace-normal');
      await expect(style.whiteSpace).toBe('normal');
    }
  }
  await expect(region.scrollWidth).toBeLessThanOrEqual(region.clientWidth + 1);
}

export const PreferencePhoneControls: Story = {
  name: 'Preference controls and guarded recovery',
  tags: ['!dev'],
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=lost#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const writes = () => requests.filter((request) => request.method === 'PATCH');
    const reads = () => requests.filter((request) => request.method === 'GET');
    const readingElement = await view.findByRole('region', { name: m.settings_reading_heading() });
    const reading = within(readingElement);
    const initialReads = reads().length;
    await expect(writes()).toHaveLength(0);
    await expect(view.queryByRole('heading', { name: m.settings_notifications_heading() })).toBeNull();
    const spoiler = reading.getByRole('radio', { name: m.settings_spoiler_1_title() });
    const spoilerLabel = spoiler.closest('label');
    if (!spoilerLabel) throw new Error('Reading choice lost its touch label');
    await expect(spoilerLabel.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(spoiler);
    await reading.findByText(m.settings_reading_uncertain_title());
    await comfortableControls(readingElement);
    await expect(reads()).toHaveLength(initialReads);
    await expect(writes()).toHaveLength(1);
    const readingOriginal = { ...writes()[0]! };
    await expect(readingOriginal).toMatchObject({ method: 'PATCH', path: '/v1/accounts/story-viewer/preferences' });
    await expect(JSON.parse(readingOriginal.body)).toEqual({ expectedVersion: 0, spoilerLevel: 1 });
    await expect(readingOriginal.key).toBeTruthy();
    const suitability = reading.getByRole('switch', { name: m.settings_suitability_title() });
    await userEvent.click(suitability);
    await expect(writes()).toHaveLength(1);

    await expect(reads()).toHaveLength(initialReads);
    await userEvent.click(reading.getByRole('button', { name: m.settings_reading_retry_original() }));
    await reading.findByText(m.settings_reading_review_title());
    await comfortableControls(readingElement);
    await expect(writes()).toHaveLength(2);
    await expect(writes()[1]).toEqual(readingOriginal);
    await expect(reads()).toHaveLength(initialReads + 1);
    await expect(reading.getByRole('button', { name: m.settings_reading_save_draft() })).toBeEnabled();
    await userEvent.click(reading.getByRole('button', { name: m.settings_reading_use_current() }));
    await expect(suitability).not.toBeChecked();
    await expect(writes()).toHaveLength(2);

    notificationMode = true;
    await selectSettingsCategory(context.canvasElement, m.settings_notifications_heading());
    const noticesElement = await view.findByRole('region', { name: m.settings_notifications_heading() });
    const notices = within(noticesElement);
    await expect(notices.getByRole('heading', { name: m.settings_notifications_heading() })).toHaveFocus();
    await notices.findByText(m.settings_automatic_save_help());
    await comfortableControls(noticesElement);
    await expect(view.queryByRole('radio')).toBeNull();
    const reply = notices.getByRole('switch', { name: m.settings_notification_reply() });
    const mention = notices.getByRole('switch', { name: m.settings_notification_mention() });
    const replyLabel = reply.closest('label');
    if (!replyLabel) throw new Error('Notice switch lost its touch label');
    await expect(replyLabel.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(replyLabel);
    await notices.findByText(m.settings_notifications_uncertain_title());
    await comfortableControls(noticesElement);
    await expect(writes()).toHaveLength(3);
    const noticeOriginal = { ...writes()[2]! };
    await expect(JSON.parse(noticeOriginal.body)).toEqual({ expectedVersion: 1, notifications: { reply: false } });
    await expect(noticeOriginal.key).not.toBe(readingOriginal.key);
    await expect(notices.getByRole('button', { name: m.settings_notifications_restore() })).toBeDisabled();
    await userEvent.click(mention);
    await expect(writes()).toHaveLength(3);
    await expect(reads()).toHaveLength(initialReads + 1);
    // Real category navigation retains the unresolved original and later draft, without additional reads.
    await selectSettingsCategory(context.canvasElement, m.settings_reading_heading());
    await expect(spoiler).toBeChecked();
    await expect(suitability).not.toBeChecked();
    await expect(reading.getByRole('heading', { name: m.settings_reading_heading() })).toHaveFocus();
    await expect(view.queryByRole('switch', { name: m.settings_notification_reply() })).toBeNull();
    await selectSettingsCategory(context.canvasElement, m.settings_notifications_heading());
    await expect(reply).not.toBeChecked();
    await expect(mention).not.toBeChecked();
    await expect(writes()).toHaveLength(3);
    await expect(reads()).toHaveLength(initialReads + 1);
    await userEvent.click(notices.getByRole('button', { name: m.settings_notifications_retry_original() }));
    await notices.findByText(m.settings_notifications_review_title());
    await comfortableControls(noticesElement);
    await expect(writes()).toHaveLength(4);
    await expect(writes()[3]).toEqual(noticeOriginal);
    await expect(reads()).toHaveLength(initialReads + 2);
    await expect(reply).not.toBeChecked();
    await expect(mention).not.toBeChecked();
    await userEvent.click(notices.getByRole('button', { name: m.settings_notifications_save_draft() }));
    await notices.findByText(m.settings_saved());
    await expect(writes()).toHaveLength(5);
    await expect(JSON.parse(writes()[4]!.body)).toEqual({
      expectedVersion: 2,
      notifications: { reply: false, mention: false },
    });
    await expect(writes()[4]!.key).not.toBe(noticeOriginal.key);
    await expect(reads()).toHaveLength(initialReads + 2);

    await selectSettingsCategory(context.canvasElement, m.settings_privacy_heading());
    const privacyElement = await view.findByRole('region', { name: m.settings_privacy_heading() });
    const privacy = within(privacyElement);
    await privacy.findAllByRole('combobox', { name: m.settings_privacy_visibility_label() });
    await comfortableControls(privacyElement);
    await privacy.findByText(m.settings_automatic_save_help());
    await expect(reads()).toHaveLength(initialReads + 3);
    const pageRead = reads().at(-1)!;
    await expect(pageRead.path).toBe('/v1/accounts/story-viewer/collections');
    await expect(new URLSearchParams(pageRead.search).get('limit')).toBe('20');
    await expect(pageRead.key).toBeNull();
    const savedRow = privacy.getByRole('link', { name: 'Books to revisit' }).closest('li');
    const conflictRow = privacy.getByRole('link', { name: /unusually long Collection title/ }).closest('li');
    if (!savedRow || !conflictRow) throw new Error('Owner Collection rows missing');
    const select = within(savedRow).getByRole('combobox');
    await expect(select).toHaveAttribute('data-slot', 'native-select');
    await expect(select.closest('[data-slot="list-row-control"]')).not.toBeNull();
    await expect(select).toHaveAccessibleDescription(
      m.settings_privacy_current({ visibility: m.settings_privacy_private() }),
    );
    await userEvent.selectOptions(select, 'unlisted');
    await within(savedRow).findByText(m.settings_saved());
    await expect(writes()).toHaveLength(6);
    await expect(writes()[5]!.path).toBe('/v1/collections/settings-collection-1');
    await expect(JSON.parse(writes()[5]!.body)).toEqual({ revision: 3, visibility: 'unlisted' });
    await expect(writes()[5]!.key).toBeTruthy();
    await expect(reads()).toHaveLength(initialReads + 3);
    await userEvent.selectOptions(within(conflictRow).getByRole('combobox'), 'private');
    await within(conflictRow).findByText(m.settings_privacy_conflict_text());
    await comfortableControls(privacyElement);
    await expect(writes()).toHaveLength(7);
    await expect(writes()[6]!.path).toBe('/v1/collections/settings-collection-conflict');
    await expect(JSON.parse(writes()[6]!.body)).toEqual({ revision: 9, visibility: 'private' });
    await expect(reads()).toHaveLength(initialReads + 3);
    await userEvent.click(within(conflictRow).getByRole('button', { name: m.settings_privacy_reload_row() }));
    await waitFor(() => expect(within(conflictRow).getByRole('combobox')).toHaveValue('public'));
    await expect(within(conflictRow).queryByRole('alert')).toBeNull();
    await within(conflictRow).findByText(m.settings_privacy_current({ visibility: m.settings_privacy_public() }));
    await expect(reads()).toHaveLength(initialReads + 4);
    await expect(reads().at(-1)!.path).toBe('/v1/collections/settings-collection-conflict');
    await expect(writes()).toHaveLength(7);
    await expect(within(conflictRow).queryByText(m.settings_saved())).toBeNull();
    await expect(privacy.getByRole('heading', { name: m.settings_privacy_heading() })).toBeVisible();

    await selectSettingsCategory(context.canvasElement, m.settings_notifications_heading());
    await expect(reply).not.toBeChecked();
    await expect(mention).not.toBeChecked();
    await selectSettingsCategory(context.canvasElement, m.settings_reading_heading());
    await expect(spoiler).toBeChecked();
    await expect(suitability).not.toBeChecked();
    await expect(writes()).toHaveLength(7);
    await expect(reads()).toHaveLength(initialReads + 4);
  },
};
