import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import creationJson from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { RealmSiteCreation } from './realm-site-creation.tsx';
import { realmSiteCreationClient, type RealmSiteCreationIntent, type RealmSiteCreationClient } from './realm-site-creation-api.ts';
import { realmSiteCreationMessages } from './realm-site-creation-messages.ts';
import { communityText } from './messages.ts';

const record = creationJson as AnswerRecord;
const command = record.personas.owner.find(item => item.label === 'creation-space')!;
const body = command.body as RealmSiteCreationIntent;
let client: RealmSiteCreationClient;
const requests: { method: string; key: string | null; body: unknown }[] = [];
const meta = { title: 'Communities/Independent site creation', component: RealmSiteCreation,
  args: { locale: 'en', actingSubject: body.actingSubject },
  parameters: { route: { pathname: '/en/r/new' } },
  render: (args, { globals }) => <main className="mx-auto max-w-3xl p-4 sm:p-8"><RealmSiteCreation {...args}
    locale={(globals.locale as UiLocale | undefined) ?? args.locale} client={client} /></main>,
} satisfies Meta<typeof RealmSiteCreation>;
export default meta;
type Story = StoryObj<typeof meta>;

function recordedStory(loading = false): Story {
  return {
    beforeEach() {
      requests.length = 0;
      const replay = recordedFetch(record, 'owner', ['creation-space', 'creation-home', 'creation-address'].map(label => ({
        label, state: loading && label === 'creation-space' ? 'loading' : 'populated',
      })), { pathPrefix: BFF_PREFIX });
      client = realmSiteCreationClient(browserMainApi('https://record.invalid', { fetcher: (async (input, init) => {
        const request = new Request(input, init);
        const text = await request.clone().text();
        requests.push({ method: request.method, key: request.headers.get('idempotency-key'), body: text ? JSON.parse(text) : undefined });
        return replay.fetcher(request);
      }) as typeof fetch }));
      return () => replay.dispose();
    },
    async play({ canvasElement, globals }) {
      const locale = (globals.locale as UiLocale | undefined) ?? 'en';
      const copy = realmSiteCreationMessages[locale];
      const canvas = within(canvasElement);
      await userEvent.type(canvas.getByRole('textbox', { name: copy.name }), body.name);
      await userEvent.click(canvas.getByRole('button', { name: communityText.nameLanguage[locale] }));
      const chooser = within(await within(document.body).findByRole('dialog'));
      await userEvent.type(chooser.getByRole('searchbox'), 'en');
      await userEvent.click(chooser.getByRole('button', { name: /English.*\ben$/ }));
      await userEvent.click(canvas.getByRole('button', { name: copy.create }));
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
      await expect(requests[0]!.body).toEqual(body);
      await expect(requests[0]!.key).toBeTruthy();
      if (loading) {
        await expect(canvas.getByRole('button', { name: copy.creating })).toBeDisabled();
        await expect(canvas.getByRole('textbox', { name: copy.name })).toHaveValue(body.name);
      } else {
        await expect(canvas.findByRole('status')).resolves.toHaveTextContent(copy.created);
        const address = record.personas.owner.find(item => item.label === 'creation-management-address')!;
        const ref = new URL(address.path, 'https://record.invalid').searchParams.get('key');
        await expect(canvas.getByRole('link', { name: copy.attach })).toHaveAttribute('href', `/${locale}/manage/z/${ref}/realm`);
        await expect(requests.map(item => item.method)).toEqual(['POST', 'PUT', 'GET']);
        await expect(requests[1]!.key).not.toBe(requests[0]!.key);
      }
    },
  };
}

export const Created: Story = recordedStory();
export const Creating: Story = recordedStory(true);
export const Phone: Story = { ...recordedStory(), globals: { viewport: { value: 'phone' } } };
