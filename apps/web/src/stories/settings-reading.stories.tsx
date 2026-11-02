import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { readingPageFixture } from '../kernel/fake/settings-preferences-reading';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const meta = { title: 'Pages/Settings/Reading and display', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
export const ReadingAndDisplay: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=default#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const reading = within(await view.findByRole('region', { name: m.settings_reading_heading() }));
    const fixture = readingPageFixture()!;
    await expect(reading.getByText(m.settings_automatic_save_help())).toBeVisible();
    await expect(fixture.calls).toHaveLength(0);
    await userEvent.click(await reading.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await reading.findByText(m.settings_saved());
    await expect(fixture.calls).toHaveLength(1);
    await expect(fixture.calls[0]).toMatchObject({ expectedVersion: 0, spoilerLevel: 1 });
    await expect(fixture.calls[0]).not.toHaveProperty('suitability');
    await expect(fixture.current()).toMatchObject({ spoilerLevel: 1, suitability: 'blur', version: 1 });
    await selectSettingsCategory(context.canvasElement, m.settings_display_heading());
    await view.findByRole('heading', { name: m.settings_display_heading() });
    const display = within(await view.findByRole('region', { name: m.shell_appearance() }));
    await expect(display.getByRole('button', { name: (name) => name.startsWith(m.shell_language()) })).toBeEnabled();
    await expect(display.getByRole('button', { name: m.shell_theme() })).toBeEnabled();
  },
};
export const LostResponse: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=lost#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_retry_original() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_save_draft() }));
    await view.findByText(m.settings_saved());
  },
};
export const ConflictAndReload: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=conflict#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await userEvent.click(await view.findByRole('radio', { name: m.settings_spoiler_1_title() }));
    await view.findByText(m.settings_conflict_title());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reload() }));
    await view.findByText(m.settings_reading_review_title());
    await expect(view.getByRole('radio', { name: m.settings_spoiler_1_title() })).toBeChecked();
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_use_current() }));
    await expect(view.getByRole('radio', { name: m.settings_spoiler_2_title() })).toBeChecked();
    await expect(view.queryByText(m.settings_conflict_title())).toBeNull();
    await userEvent.click(view.getByRole('radio', { name: m.settings_spoiler_0_title() }));
    await view.findByText(m.settings_saved());
  },
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=unavailable#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByText(m.settings_unavailable_title());
    await expect(view.queryByRole('radio')).toBeNull();
  },
};
export const Closed: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=closed#reading" />,
  play: async (context) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const reading = within(await view.findByRole('region', { name: m.settings_reading_heading() }));
    const alert = await reading.findByRole('alert');
    await within(alert).findByText(m.settings_closed_title());
    await within(alert).findByText(m.settings_closed_text());
    await expect(alert).toHaveAttribute('data-response-status', '403');
    await expect(alert).toHaveAttribute('data-response-code', 'platform_closed');
    await expect(view.queryByRole('radio')).toBeNull();
  },
};

export const DefaultCurrentRecovery: Story = {
  name: 'Default Reading current recovery announces its read without a false conflict or save failure and preserves draft and exact unresolved save',
  tags: ['!dev'],
  render: () => <PageStory visitor="Signed In" path="/settings?reading-state=lost#reading" />,
  play: async (context) => {
    await pageReady(context);
    await selectSettingsCategory(context.canvasElement, m.settings_reading_heading());
    const view = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_reading_heading() }),
    );
    const fixture = readingPageFixture()!;
    const choices = { spoilers: m.settings_spoiler_0_title(), images: m.settings_reading_blur() };
    const radio = (level: 0 | 1 | 2) =>
      view.getByRole('radio', {
        name: ([m.settings_spoiler_0_title(), m.settings_spoiler_1_title(), m.settings_spoiler_2_title()] as const)[
          level
        ],
      });
    const reload = () => view.getByRole('button', { name: m.settings_reload() });
    const retry = () => view.getByRole('button', { name: m.settings_reading_retry_original() });
    const saveDraft = () => view.getByRole('button', { name: m.settings_reading_save_draft() });
    const noFalseFeedback = async () => {
      for (const message of [
        m.settings_conflict_title(),
        m.settings_conflict_text(),
        m.settings_failed_title(),
        m.settings_failed_text(),
        m.settings_saving(),
        m.settings_saved(),
      ])
        await expect(view.queryByText(message)).toBeNull();
    };

    // A real command commits at the fake kernel boundary, but the response is lost.
    await userEvent.click(radio(1));
    await view.findByText(m.settings_reading_uncertain_title());
    await expect(fixture.calls).toHaveLength(1);
    const original = { ...fixture.calls[0]! };
    const originalJson = JSON.stringify(original);
    const reads = fixture.reads();
    await userEvent.click(view.getByRole('switch', { name: m.settings_suitability_title() }));
    const finish = fixture.holdNextRead({
      signedIn: true,
      state: 'unavailable',
      failure: {
        status: 503,
        code: 'dependency_unavailable',
        retryable: true,
        requestId: 'private-reading-request',
        retryAfter: '1',
      },
      securityHref: null,
    });
    await userEvent.click(reload());
    await within(await view.findByRole('status')).findByText(m.settings_reading_loading());
    await view.findByText(m.settings_reading_loading_text());
    await view.findByText(m.settings_reading_known(choices));
    await noFalseFeedback();
    await userEvent.click(radio(2)); // Edits during the read are independent of the original input.
    await expect(reload()).toBeDisabled();
    await expect(retry()).toBeDisabled();
    await waitFor(() => expect(fixture.reads()).toBe(reads + 1));
    await expect(fixture.calls).toEqual([original]);
    finish();

    await view.findByText(m.settings_reading_read_unavailable_title());
    await view.findByText(m.settings_reading_read_unavailable_text());
    const failure = view.getByRole('alert');
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await expect(failure).toHaveAttribute('data-response-code', 'dependency_unavailable');
    await expect(failure).toHaveAttribute('data-retry-after', '1');
    await expect(failure).not.toHaveTextContent('private-reading-request');
    await view.findByText(m.settings_reading_known(choices));
    await expect(view.queryByText(m.settings_reading_current(choices))).toBeNull();
    await expect(radio(2)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await noFalseFeedback();
    await expect(reload()).toBeDisabled();
    await expect(retry()).toBeDisabled();
    await userEvent.click(reload());
    await userEvent.click(retry());
    await expect(fixture.reads()).toBe(reads + 1);
    await expect(fixture.calls).toEqual([original]);
    await waitFor(() => expect(reload()).toBeEnabled(), { timeout: 4000 });
    await expect(fixture.reads()).toBe(reads + 1); // Expiry never starts a request.
    await expect(fixture.calls).toEqual([original]);

    await userEvent.click(reload());
    await view.findByText(m.settings_reading_uncertain_title());
    await expect(fixture.reads()).toBe(reads + 2);
    await expect(fixture.calls).toEqual([original]);
    await expect(radio(2)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await noFalseFeedback();
    await userEvent.click(retry());
    await view.findByText(m.settings_reading_review_title());
    await expect(fixture.calls).toEqual([original, original]);
    await expect(JSON.stringify(fixture.calls[1])).toBe(originalJson);
    await expect(fixture.reads()).toBe(reads + 3);
    await expect(radio(2)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await expect(view.queryByText(m.settings_saved())).toBeNull();

    // A definitely rejected draft still offers review and explicit discard as separate choices.
    fixture.concurrent({ spoilerLevel: 0 });
    await userEvent.click(saveDraft());
    await view.findByText(m.settings_conflict_title());
    await view.findByText(m.settings_conflict_text());
    const rejected = fixture.calls.map((input) => ({ ...input }));
    const denied = fixture.holdNextRead({
      signedIn: true,
      state: 'unavailable',
      failure: { status: 403, code: 'forbidden' },
      securityHref: null,
    });
    await userEvent.click(reload());
    await view.findByText(m.settings_reading_loading());
    await noFalseFeedback();
    denied();
    await view.findByText(m.settings_reading_read_denied_title());
    await view.findByText(m.settings_reading_read_denied_text());
    await noFalseFeedback();
    await expect(fixture.calls).toEqual(rejected);
    await userEvent.click(reload());
    await view.findByText(m.settings_reading_review_title());
    await expect(radio(2)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await expect(fixture.calls).toEqual(rejected);
    await userEvent.click(saveDraft());
    await view.findByText(m.settings_saved());
    await expect(fixture.calls).toHaveLength(rejected.length + 1);
    await expect(fixture.calls.at(-1)).toMatchObject({
      expectedVersion: fixture.current().version - 1,
      spoilerLevel: 2,
      suitability: 'show',
    });
    await expect(fixture.calls.at(-1)!.idempotencyKey).not.toBe(original.idempotencyKey);

    fixture.concurrent({ spoilerLevel: 0, suitability: 'blur' });
    await userEvent.click(radio(1));
    await view.findByText(m.settings_conflict_title());
    const beforeDiscard = fixture.calls.map((input) => ({ ...input }));
    const closed = fixture.holdNextRead({
      signedIn: true,
      state: 'closed',
      failure: { status: 403, code: 'platform_closed' },
      securityHref: null,
    });
    await userEvent.click(reload());
    await view.findByText(m.settings_reading_loading());
    closed();
    await view.findByText(m.settings_reading_read_closed_title());
    await view.findByText(m.settings_reading_read_closed_text());
    await noFalseFeedback();
    await expect(radio(1)).toBeChecked(); // Failed discard-read keeps the draft available.
    await expect(reload()).toBeEnabled();
    await userEvent.click(reload());
    await view.findByText(m.settings_reading_review_title());
    await expect(radio(1)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).toBeChecked();
    await expect(fixture.calls).toEqual(beforeDiscard);
    await userEvent.click(view.getByRole('button', { name: m.settings_reading_use_current() }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    await expect(radio(0)).toBeChecked();
    await expect(view.getByRole('switch', { name: m.settings_suitability_title() })).not.toBeChecked();
    await expect(fixture.calls).toEqual(beforeDiscard);
    await noFalseFeedback();
  },
};
