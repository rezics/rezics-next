import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import creationJson from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { forgetReadingLanguages } from '../content-language/use-reading-languages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { CreateCommunityPage } from './create-page.tsx';
import type { RealmSiteCreationIntent } from './realm-site-creation-api.ts';
import { realmSiteCreationMessages } from './realm-site-creation-messages.ts';

const record = creationJson as AnswerRecord;
const command = record.personas.owner.find(item => item.label === 'creation-space')!;
const body = command.body as RealmSiteCreationIntent;
const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
const misses: unknown[] = [];
const meta = { title: 'Communities/Independent site creation', component: CreateCommunityPage,
  args: { locale: 'en', signedIn: true, actingSubject: body.actingSubject },
  parameters: { route: { pathname: '/en/r/new' } },
  render: (args, { globals }) => <CreateCommunityPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof CreateCommunityPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function recordedStory(mode: 'created' | 'loading' | 'recovery' = 'created'): Story {
  return {
    beforeEach() {
      requests.length = 0; misses.length = 0; forgetReadingLanguages();
      const labels = ['creation-page-preferences', 'creation-page-concepts', 'creation-space', ...(mode === 'recovery' ? ['creation-space-replay'] : []),
        'creation-home', ...(mode === 'recovery' ? ['creation-home-replay'] : []), 'creation-address'];
      const replay = recordedFetch(record, 'owner', labels.map(label => ({
        label, state: mode === 'loading' && label === 'creation-space' ? 'loading' : 'populated',
      })), { pathPrefix: BFF_PREFIX, sequence: true });
      const original = window.fetch;
      const dropped = new Set<string>();
      window.fetch = (async (input, init) => {
        const request = new Request(input instanceof Request ? input.clone() : new URL(String(input), window.location.origin), init);
        const path = new URL(request.url).pathname;
        if (!path.startsWith(`${BFF_PREFIX}/`)) return original(input, init);
        const text = await request.clone().text();
        requests.push({ method: request.method, path, key: request.headers.get('idempotency-key'), body: text ? JSON.parse(text) : undefined });
        let response: Response;
        try { response = await replay.fetcher(request); }
        catch (error) { misses.push(error); throw error; }
        // Drop only the transport response, after replay has matched the recorded command and real receipt.
        if (mode === 'recovery' && request.method !== 'GET' && !dropped.has(request.method)) {
          dropped.add(request.method);
          throw new TypeError('Response lost after the command reached Main');
        }
        return response;
      }) as typeof fetch;
      return () => { window.fetch = original; replay.dispose(); forgetReadingLanguages(); };
    },
    async play({ canvasElement, globals }) {
      const locale = (globals.locale as UiLocale | undefined) ?? 'en';
      const copy = realmSiteCreationMessages[locale];
      const page = within(canvasElement);
      await expect(page.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      const canvas = within(page.getByRole('region', { name: copy.title }));
      await expect(canvas.getByText(copy.help)).toBeVisible();
      await userEvent.type(canvas.getByRole('textbox', { name: copy.name }), body.name);
      await userEvent.click(canvas.getByRole('button', { name: copy.nameLanguage }));
      const chooser = within(await within(document.body).findByRole('dialog'));
      await userEvent.type(chooser.getByRole('searchbox'), 'en');
      await userEvent.click(chooser.getByRole('button', { name: /English.*\ben$/ }));
      await userEvent.click(canvas.getByRole('button', { name: copy.create }));
      const writes = () => requests.filter(item => item.method !== 'GET');
      await waitFor(() => expect(writes().length).toBeGreaterThan(0));
      await expect(writes()[0]!.body).toEqual(body);
      await expect(writes()[0]!.key).toBeTruthy();
      if (mode === 'loading') {
        await expect(canvas.getByRole('button', { name: copy.creating })).toBeDisabled();
        await expect(canvas.getByRole('textbox', { name: copy.name })).toHaveValue(body.name);
      } else {
        if (mode === 'recovery') {
          await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.failed);
          await expect(canvas.getByRole('textbox', { name: copy.name })).toBeDisabled();
          await userEvent.click(canvas.getByRole('button', { name: copy.create }));
          await waitFor(() => expect(writes()).toHaveLength(3));
          await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.failed);
          await expect(writes()[1]).toEqual(writes()[0]);
          await userEvent.click(canvas.getByRole('button', { name: copy.create }));
        }
        await expect(canvas.findByRole('status')).resolves.toHaveTextContent(copy.created);
        const address = record.personas.owner.find(item => item.label === 'creation-management-address')!;
        const ref = new URL(address.path, 'https://record.invalid').searchParams.get('key');
        const attachment = canvas.getByRole('link', { name: copy.attach });
        await expect(attachment).toHaveAttribute('href', `/${locale}/manage/z/${ref}/realm`);
        await expect(writes().map(item => item.method)).toEqual(mode === 'recovery' ? ['POST', 'POST', 'PUT', 'PUT'] : ['POST', 'PUT']);
        if (mode === 'recovery') await expect(writes()[3]).toEqual(writes()[2]);
        await expect(new Set(writes().filter(item => item.method === 'POST').map(item => item.key)).size).toBe(1);
        await expect(writes().find(item => item.method === 'PUT')!.key).not.toBe(writes()[0]!.key);
        await expect(requests).toHaveLength(labelsFor(mode));
      }
      await expect(misses).toEqual([]);
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
}

function labelsFor(mode: 'created' | 'recovery') { return mode === 'recovery' ? 7 : 5; }

export const Created: Story = recordedStory();
export const Creating: Story = recordedStory('loading');
export const LostResponses: Story = recordedStory('recovery');
export const Phone: Story = { ...recordedStory(), globals: { viewport: { value: 'phone' } } };
export const PhoneRecovery: Story = { ...recordedStory('recovery'), globals: { viewport: { value: 'phone' } } };
