import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

const meta = { title: 'Pages/Settings/Profile', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;
export const Self: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=self#profile" />,
  play: async (context) => {
    await pageReady(context);
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Avery Updated');
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
    const activity = within(
      within(context.canvasElement).getByRole('region', { name: m.settings_public_activity_heading() }),
    );
    await userEvent.click(activity.getByRole('switch', { name: m.settings_public_reviews() }));
    await activity.findByText(m.settings_saved());
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(name).toHaveValue('Avery Updated');
    await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
    await expect(activity.getByRole('switch', { name: m.settings_public_reviews() })).not.toBeChecked();
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    await expect(name).toBeVisible();
  },
};
export const Handleless: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=handleless#profile" />,
  play: async (context) => {
    await pageReady(context);
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
    await expect(name).toHaveValue('Avery Reader');
    await expect(profile.getByRole('textbox', { name: m.settings_profile_biography() })).not.toHaveValue('');
    await userEvent.clear(name);
    await userEvent.type(name, 'Handleless Reader');
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_reload_current() }));
    await expect(name).toHaveValue('Handleless Reader');
  },
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?profile=unavailable#public-activity" />,
};

const rawDiagnostic = 'raw-profile-diagnostic bearer=secret-token subject:write settings_profile_network_error';
type RecoveryRead = ReturnType<typeof Promise.withResolvers<boolean>>;
const recoveryTraffic: {
  writes: { path: string; body: unknown; key: string | null }[];
  reads: Request[];
  nextRead?: RecoveryRead | undefined;
} = { writes: [], reads: [] };

export const SharedRecovery: Story = {
  name: 'Shared profile and activity recovery',
  tags: ['!dev'],
  beforeEach: () => {
    recoveryTraffic.writes = [];
    recoveryTraffic.reads = [];
    recoveryTraffic.nextRead = undefined;
    const original = globalThis.fetch;
    let heldRead: RecoveryRead | undefined;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.origin !== 'http://kernel.local') return original(input, init);
      const request = new Request(input, init);
      const problem = (status: number, code: string) =>
        Response.json(
          {
            type: `https://rezics.com/problems/${code}`,
            title: 'Native diagnostic',
            status,
            code,
            detail: rawDiagnostic,
            request_id: 'profile-recovery-request',
            retryable: status === 503,
          },
          { status, headers: { 'retry-after': '0' } },
        );
      if (request.method === 'GET' && /^\/v1\/accounts\/[^/]+\/profile$/.test(url.pathname)) {
        recoveryTraffic.reads.push(request);
        heldRead = recoveryTraffic.nextRead;
        recoveryTraffic.nextRead = undefined;
        if (heldRead && (await heldRead.promise)) return problem(503, 'dependency_unavailable');
      }
      if (request.method === 'PATCH' && /^\/v1\/accounts\/[^/]+$/.test(url.pathname)) {
        recoveryTraffic.writes.push({
          path: url.pathname,
          body: await request.clone().json(),
          key: request.headers.get('idempotency-key'),
        });
        const count = recoveryTraffic.writes.length;
        if (count === 1 || count === 5) return problem(403, 'forbidden');
        if (count === 2) return problem(503, 'dependency_unavailable');
      }
      return original(request);
    }) as typeof fetch;
    return () => {
      heldRead?.resolve(false);
      recoveryTraffic.nextRead?.resolve(false);
      globalThis.fetch = original;
    };
  },
  render: () => <PageStory visitor="Signed In" path="/settings#profile" />,
  play: async (context) => {
    await context.step(
      'Default Profile and Public activity recovery distinguishes current-profile reads from writes without raw backend messages and preserves exact original intent and later drafts',
      async () => {
        await pageReady(context);
        const view = within(context.canvasElement);
        const profile = within(await view.findByRole('region', { name: m.settings_profile_heading() }));
        const name = await profile.findByRole('textbox', { name: m.settings_profile_display_name() });
        const initialName = (name as HTMLInputElement).value;
        // Visit both real callers before recovery; switching categories retains the same editor.
        await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
        const activity = within(view.getByRole('region', { name: m.settings_public_activity_heading() }));
        const reviews = await activity.findByRole('switch', { name: m.settings_public_reviews() });
        const wasChecked = reviews.getAttribute('aria-checked') === 'true';
        await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
        await userEvent.clear(name);
        await userEvent.type(name, `${initialName} original`);
        await expect(recoveryTraffic.writes).toHaveLength(0);
        await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
        const refusal = await profile.findByRole('alert');
        await expect(refusal).toHaveTextContent(m.settings_profile_edit_denied());
        await expect(refusal).not.toHaveTextContent(rawDiagnostic);
        await expect(refusal).not.toHaveTextContent('subject:write');
        await expect(profile.queryByRole('button', { name: m.settings_profile_retry_save() })).toBeNull();
        await expect(profile.queryByText(m.settings_saved())).toBeNull();
        await expect(recoveryTraffic.writes).toHaveLength(1);
        await expect(recoveryTraffic.writes[0]!.body).toEqual({ displayName: `${initialName} original` });

        await userEvent.clear(name);
        await userEvent.type(name, `${initialName} intended`);
        const firstReadCount = recoveryTraffic.reads.length;
        const check = Promise.withResolvers<boolean>();
        recoveryTraffic.nextRead = check;
        await userEvent.click(profile.getAllByRole('button', { name: m.settings_profile_reload_current() })[0]!);
        await expect(await profile.findByText(m.settings_profile_checking())).toHaveAttribute('role', 'status');
        await expect(profile.queryByText(m.settings_saving())).toBeNull();
        await expect(profile.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
        await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
        await expect(activity.getByText(m.settings_profile_checking())).toBeVisible();
        await expect(activity.queryByText(m.settings_saving())).toBeNull();
        check.resolve(false);
        await waitFor(() => expect(activity.queryByText(m.settings_profile_checking())).toBeNull());
        await expect(recoveryTraffic.reads).toHaveLength(firstReadCount + 1);
        await expect(recoveryTraffic.writes).toHaveLength(1);
        await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
        await expect(name).toHaveValue(`${initialName} intended`);

        // An unavailable command remains unresolved even after a successful current read.
        await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
        await profile.findByText(m.settings_profile_save_unknown());
        await expect(profile.getByRole('alert')).toHaveTextContent(m.settings_profile_save_unavailable());
        await expect(profile.getByRole('alert')).not.toHaveTextContent(rawDiagnostic);
        const originalAttempt = structuredClone(recoveryTraffic.writes[1]!);
        await expect(originalAttempt.body).toEqual({ displayName: `${initialName} intended` });
        await expect(originalAttempt.key).toBeTruthy();
        await expect(originalAttempt.key).not.toBe(recoveryTraffic.writes[0]!.key);
        await userEvent.clear(name);
        await userEvent.type(name, `${initialName} later`);
        const uncertainReadCount = recoveryTraffic.reads.length;
        await userEvent.click(profile.getAllByRole('button', { name: m.settings_profile_reload_current() })[0]!);
        await profile.findByText(m.settings_profile_save_unknown());
        await expect(recoveryTraffic.reads).toHaveLength(uncertainReadCount + 1);
        await expect(recoveryTraffic.writes).toHaveLength(2);
        await expect(name).toHaveValue(`${initialName} later`);

        // A receipt followed by a failed read must retain the original attempt and the later draft.
        const failedConfirmation = Promise.withResolvers<boolean>();
        recoveryTraffic.nextRead = failedConfirmation;
        await userEvent.click(profile.getByRole('button', { name: m.settings_profile_retry_save() }));
        await expect(await profile.findByText(m.settings_profile_confirming())).toHaveAttribute('role', 'status');
        await expect(profile.queryByText(m.settings_saving())).toBeNull();
        await expect(recoveryTraffic.writes[2]).toEqual(originalAttempt);
        failedConfirmation.resolve(true);
        await profile.findByText(m.settings_profile_read_failed());
        await expect(profile.getByRole('alert')).toHaveTextContent(m.settings_profile_save_unknown());
        await expect(profile.getByRole('alert')).not.toHaveTextContent(rawDiagnostic);
        await expect(profile.queryByText(m.settings_saved())).toBeNull();
        await expect(name).toHaveValue(`${initialName} later`);

        const confirmation = Promise.withResolvers<boolean>();
        recoveryTraffic.nextRead = confirmation;
        await userEvent.click(profile.getByRole('button', { name: m.settings_profile_retry_save() }));
        await profile.findByText(m.settings_profile_confirming());
        await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
        await expect(activity.getByText(m.settings_profile_confirming())).toBeVisible();
        await expect(activity.queryByText(m.settings_saving())).toBeNull();
        await expect(recoveryTraffic.writes).toHaveLength(4);
        await expect(recoveryTraffic.writes[3]).toEqual(originalAttempt);
        confirmation.resolve(false);
        await waitFor(() => expect(activity.queryByText(m.settings_profile_confirming())).toBeNull());
        await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
        await expect(name).toHaveValue(`${initialName} later`);
        await expect(profile.getByText(m.settings_profile_review_needed())).toBeVisible();
        await expect(profile.queryByText(m.settings_saved())).toBeNull();
        await expect(profile.queryByRole('button', { name: m.settings_profile_retry_save() })).toBeNull();
        await expect(profile.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();

        // Actual automatic Public activity saves carry only that operation, never the later Profile draft.
        await selectSettingsCategory(context.canvasElement, m.settings_public_activity_heading());
        await userEvent.click(reviews);
        await expect(await activity.findByRole('alert')).toHaveTextContent(m.settings_public_activity_denied());
        await expect(activity.getByRole('alert')).not.toHaveTextContent(m.settings_profile_edit_denied());
        await expect(activity.getByRole('alert')).not.toHaveTextContent(rawDiagnostic);
        await expect(activity.queryByText(m.settings_saved())).toBeNull();
        await expect(recoveryTraffic.writes).toHaveLength(5);
        await expect(recoveryTraffic.writes[4]!.path).toBe(originalAttempt.path);
        await expect(recoveryTraffic.writes[4]!.body).toEqual({ publicViews: { reviews: !wasChecked } });
        await expect(recoveryTraffic.writes[4]!.key).not.toBe(originalAttempt.key);
        const activityReadCount = recoveryTraffic.reads.length;
        const activityCheck = Promise.withResolvers<boolean>();
        recoveryTraffic.nextRead = activityCheck;
        await userEvent.click(activity.getByRole('button', { name: m.settings_profile_reload_current() }));
        await activity.findByText(m.settings_profile_checking());
        await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
        await expect(profile.getByText(m.settings_profile_checking())).toBeVisible();
        await expect(profile.queryByText(m.settings_saving())).toBeNull();
        activityCheck.resolve(false);
        await waitFor(() => expect(profile.queryByText(m.settings_profile_checking())).toBeNull());
        await expect(recoveryTraffic.reads).toHaveLength(activityReadCount + 1);
        await expect(recoveryTraffic.writes).toHaveLength(5);
        await expect(name).toHaveValue(`${initialName} later`);
        for (const request of recoveryTraffic.reads) {
          const url = new URL(request.url);
          await expect(url.pathname).toBe(`${originalAttempt.path}/profile`);
          await expect(url.search).toBe('');
          await expect(request.headers.get('cache-control')).toBe('no-store');
        }
      },
    );
  },
};
