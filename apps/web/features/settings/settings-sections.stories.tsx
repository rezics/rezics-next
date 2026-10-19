import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SettingsSections } from './settings-sections.tsx';
import { englishMessages as t } from './messages.ts';
import type { PersonPreferences } from './person-preferences.ts';
import { chooseOption } from '../stories/choose-option.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const meta = { title: 'Settings/Preferences', component: SettingsSections,
  args: { agent, locale: 'en', accountOrigin: 'https://account.rezics.test', t },
  decorators: [Story => <div className="mx-auto grid max-w-2xl gap-6 p-4"><Story /></div>],
} satisfies Meta<typeof SettingsSections>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectBusyDraftReadable(content: ReturnType<typeof within>, search: HTMLElement) {
  search.scrollIntoView({ block: 'center' });
  const notice = content.getByText(t.personSaving);
  const selected = within(content.getByRole('region', { name: 'Your languages, first choice first' }));
  const rows = selected.getAllByRole('listitem');
  await expect(rows).toHaveLength(3);
  for (const [index, name] of ['English', '한국어', 'français'].entries()) {
    await expect(rows[index]).toHaveTextContent(name);
  }
  await waitFor(async () => {
    const message = notice.getBoundingClientRect();
    await expect(message.top).toBeGreaterThanOrEqual(0);
    await expect(message.bottom).toBeLessThanOrEqual(window.innerHeight);
    for (const row of rows) {
      const bounds = row.getBoundingClientRect();
      await expect(bounds.top).toBeGreaterThanOrEqual(0);
      await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
      await expect(bounds.bottom <= message.top || bounds.top >= message.bottom).toBe(true);
    }
  });
  await expect(notice).toBeVisible();
  await expect(search).toBeVisible();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

function preferenceScenario(firstStatus: 200 | 503 | 409, phone: boolean,
  trigger: 'privacy' | 'spoiler' = 'privacy', savingOnly = false, refreshFails = false): Story {
  let release: () => void;
  let commands: Record<string, unknown>[];
  return {
    globals: { viewport: { value: phone ? 'phone' : 'desktop1440' } },
    async beforeEach() {
      commands = [];
      let failedRead = false;
      let saved: PersonPreferences = { profile: 'person-preferences-v1', profileVisibility: 'public',
        followPolicy: 'everyone', hideReadingActivity: false, contentLanguages: ['ja', 'en'],
        spoilerPolicy: 'hide-unread', version: 7, blockedPeople: [] };
      const gate = new Promise<void>(resolve => { release = resolve; });
      const prior = globalThis.fetch;
      globalThis.fetch = (async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
        if (path.endsWith('/person-preferences')) {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            commands.push(body);
            if (commands.length === 1) {
              await gate;
              if (firstStatus === 409) saved = { ...saved, version: 8, followPolicy: 'nobody', contentLanguages: ['ko'] };
              if (firstStatus !== 200) return new Response(null, { status: firstStatus });
            }
            const { actingSubject: _subject, expectedVersion: _version, ...values } = body;
            saved = { ...saved, ...values, version: saved.version + 1 };
          } else if (saved.version === 8 && refreshFails && !failedRead) {
            failedRead = true;
            return new Response(null, { status: 503 });
          }
          return Response.json(saved);
        }
        if (path.endsWith('/onboarding/choices')) return Response.json({ languages: ['ja', 'en', 'ko', 'fr'] });
        if (path.endsWith('/library-visibility')) return Response.json({ visibility: 'private', version: 0 });
        if (path.endsWith('/reader/settings')) return Response.json({ profile: 'reader-settings-v1', fontSize: 17,
          lineWidth: 'medium', typeface: 'serif', paragraphIndent: false, theme: 'system', cjkSpacing: 'auto',
          cjkPunctuation: 'standard', version: 0 });
        if (path.endsWith('/notification-preferences')) return Response.json({ items: [] });
        throw new Error(`Unexpected fixture request: ${path}`);
      }) as typeof fetch;
      return () => { release(); globalThis.fetch = prior; };
    },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      const content = within(await canvas.findByRole('group', { name: t.contentPreferences }));
      content.getByRole('button', { name: 'Move English up' }).focus();
      await userEvent.keyboard('{Enter}');
      await userEvent.click(content.getByRole('button', { name: 'Remove Japanese' }));
      await userEvent.click(await content.findByRole('button', { name: 'Add 한국어 Korean' }));
      const search = content.getByRole('searchbox', { name: 'Add another language' });
      await userEvent.type(search, 'fr');
      const other = within(content.getByRole('region', { name: 'Add another language' }));
      await userEvent.click(other.getByRole('button', { name: 'Add français French fr' }));
      // Leave search results open to cover every language interaction during the save.
      await userEvent.type(search, 'de');
      await expect(other.getByRole('button', { name: 'Add Deutsch German de' })).toHaveTextContent('Deutsch');
      await expect(other.getByRole('button', { name: 'Add Nederlands Dutch nl' })).toHaveTextContent('Nederlands');
      if (trigger === 'privacy') {
        await userEvent.click(canvas.getByRole('switch', { name: t.hideReadingActivity }));
      } else {
        await userEvent.click(content.getByRole('combobox', { name: t.spoilerHandling }));
        await chooseOption(within(canvasElement.ownerDocument.body), t.spoilerShow);
      }
      await expect(await canvas.findByRole('status')).toHaveTextContent(t.personSaving);
      for (const control of content.getAllByRole('button')) await expect(control).toBeDisabled();
      await expect(search).toBeDisabled();
      await expect(canvas.getByRole('combobox', { name: t.profileVisibility })).toBeDisabled();
      await expect(canvas.getByRole('combobox', { name: t.whoCanFollow })).toBeDisabled();
      await expect(content.getByRole('combobox', { name: t.spoilerHandling })).toBeDisabled();
      await expect(commands).toHaveLength(1);
      await expect(commands[0]).toMatchObject({ actingSubject: agent, expectedVersion: 7,
        contentLanguages: ['en', 'ko', 'fr'],
        ...(trigger === 'privacy' ? { hideReadingActivity: true } : { spoilerPolicy: 'show' }) });
      if (phone) await expectBusyDraftReadable(content, search);
      if (savingOnly) return;
      release();
      const expected = firstStatus === 200 ? t.personSaved : firstStatus === 503 ? t.personFailed
        : refreshFails ? t.personRefreshFailed : t.personConflict;
      await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(expected));
      if (firstStatus !== 200) {
        // Resolve the unsaved preferences before a different action can replace their feedback.
        await expect(canvas.getByRole('textbox', { name: t.blockPerson })).toBeDisabled();
        await expect(content.getByRole('button', { name: 'Remove English' })).toBeInTheDocument();
        await expect(content.getByRole('button', { name: 'Remove Korean' })).toBeInTheDocument();
        await expect(content.getByRole('button', { name: 'Remove French' })).toBeInTheDocument();
        await expect(canvas.queryByText(t.personSaved)).not.toBeInTheDocument();
        if (refreshFails) {
          await expect(search).toBeDisabled();
          await userEvent.click(canvas.getByRole('button', { name: t.reviewLatest }));
          await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(t.personConflict));
          await expect(commands).toHaveLength(1);
        }
        await userEvent.click(canvas.getByRole('button', { name: t.retrySave }));
        await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(t.personSaved));
        await expect(commands[1]).toMatchObject({ expectedVersion: firstStatus === 409 ? 8 : 7,
          contentLanguages: ['en', 'ko', 'fr'],
          ...(firstStatus === 409 ? { followPolicy: 'nobody' } : {}),
          ...(trigger === 'privacy' ? { hideReadingActivity: true } : { spoilerPolicy: 'show' }) });
      }
      await expect(search).toBeEnabled();
      await expect(canvas.getByRole('textbox', { name: t.blockPerson })).toBeEnabled();
      // A receipt must disappear as soon as a newer language draft is accepted.
      await userEvent.click(content.getByRole('button', { name: 'Move Korean up' }));
      await expect(canvas.queryByText(t.personSaved)).not.toBeInTheDocument();
      await expect(content.getByText(t.personUnsaved)).toBeVisible();
      await userEvent.click(content.getByRole('button', { name: t.saveSection }));
      await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent(t.personSaved));
      await expect(commands.at(-1)).toMatchObject({ contentLanguages: ['ko', 'en', 'fr'],
        expectedVersion: firstStatus === 409 ? 9 : 8 });
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
}

export const SlowPrivacySave: Story = preferenceScenario(200, false);
export const SlowSpoilerSavePhone: Story = preferenceScenario(200, true, 'spoiler');
export const SavingPreferencesPhone: Story = preferenceScenario(200, true, 'privacy', true);
export const FailedSaveRetainsDraft: Story = preferenceScenario(503, true);
export const ConflictRetainsDraft: Story = preferenceScenario(409, false);
export const ConflictRefreshFailure: Story = preferenceScenario(409, true, 'spoiler', false, true);
