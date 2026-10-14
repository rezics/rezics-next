import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { forgetReadingLanguages } from '../content-language/use-reading-languages.ts';
import { realmHref } from '../realm/route.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { CreateCommunityPage } from './create-page.tsx';
import { creationStoryInputs, type CreationStoryState, type foundingPersonas } from './creation-story-inputs.ts';
import { communityText as words } from './messages.ts';

const navigation = fn();
const requests: { method: string; path: string; key: string | null; body: unknown }[] = [];
const meta = {
  title: 'Communities/Realm creation', component: CreateCommunityPage,
  args: { locale: 'en', signedIn: true, actingSubject: creationStoryInputs('stranger').body.actingSubject },
  parameters: { route: { pathname: '/en/r/new', onPush: navigation } },
  globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <CreateCommunityPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof CreateCommunityPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function formStory(persona: typeof foundingPersonas[number], state: CreationStoryState = 'created'): Story {
  const inputs = creationStoryInputs(persona, state);
  return {
    args: { actingSubject: inputs.body.actingSubject },
    parameters: { constructedFromContract: true, missingRecordedStates: inputs.missingRecordedStates },
    beforeEach() {
      navigation.mockClear(); requests.length = 0; forgetReadingLanguages();
      const transport = recordedFetch(inputs.record, persona, inputs.record.personas[persona].map(sample => ({
        label: sample.label, state: sample.label === 'form-creation' && state === 'loading' ? 'loading'
          : sample.status === 202 ? 'pending' : sample.status >= 400 ? 'error' : 'populated',
      })), { pathPrefix: BFF_PREFIX });
      const original = window.fetch;
      const storageKey = `rezics:community-setup:${inputs.body.actingSubject}:${inputs.answer.realm}`;
      const stored = localStorage.getItem(storageKey);
      window.fetch = (async (input, init) => {
        const request = new Request(new URL(input instanceof Request ? input.url : String(input), window.location.origin), init);
        if (!new URL(request.url).pathname.startsWith(`${BFF_PREFIX}/`)) return original(input, init);
        const body = await request.clone().text();
        requests.push({ method: request.method, path: new URL(request.url).pathname,
          key: request.headers.get('idempotency-key'), body: body ? JSON.parse(body) : undefined });
        return transport.fetcher(request);
      }) as typeof fetch;
      return () => {
        window.fetch = original; transport.dispose(); forgetReadingLanguages();
        if (stored === null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, stored);
      };
    },
    async play({ canvasElement, globals }) {
      const locale = (globals.locale as UiLocale | undefined) ?? 'en';
      const canvas = within(canvasElement);
      await expect(canvas.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      await userEvent.type(canvas.getByRole('textbox', { name: words.name[locale] }), inputs.body.name);
      await userEvent.type(canvas.getByRole('textbox', { name: words.handle[locale] }), inputs.body.handle!);
      await userEvent.type(canvas.getByRole('textbox', { name: words.description[locale] }), 'Original description by the founding fixture Person.');
      await userEvent.click(canvas.getByRole('button', { name: new RegExp(`^${words.nameLanguage[locale]}`) }));
      const dialog = within(await within(document.body).findByRole('dialog'));
      await userEvent.type(dialog.getByRole('searchbox'), 'en');
      await userEvent.click(dialog.getByRole('button', { name: /English.*\ben$/ }));
      await userEvent.click(canvas.getByRole('radio', { name: new RegExp(`^${words.private[locale]}`) }));
      await userEvent.click(canvas.getByRole('button', { name: words.submitCreate[locale] }));
      await waitFor(() => expect(requests.filter(request => request.path === `${BFF_PREFIX}/v1/spaces`).length).toBeGreaterThan(0));
      if (state === 'loading') {
        await expect(canvas.getByRole('button', { name: words.creating[locale] })).toBeVisible();
      } else if (state === 'pending') {
        await expect(canvas.findByText(words.creationPending[locale])).resolves.toBeVisible();
        await expect(canvas.queryByRole('alert')).toBeNull();
        await userEvent.click(canvas.getByRole('button', { name: words.submitCreate[locale] }));
        await waitFor(() => expect(requests.filter(request => request.path === `${BFF_PREFIX}/v1/spaces`)).toHaveLength(4));
      } else if (['quota', 'conflict', 'expired'].includes(state)) {
        await expect(canvas.findByRole('alert')).resolves.toHaveTextContent((inputs.command.answer as { title: string }).title);
      } else if (state === 'owned') {
        await expect(canvas.findByRole('link', { name: words.openYours[locale] })).resolves.toHaveAttribute('href', realmHref(locale, inputs.answer.realm.slice(-36)));
        await expect(canvas.getByRole('alert')).toHaveTextContent(words.alreadyYours[locale]);
      } else if (state === 'taken') {
        await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(words.handleTaken[locale]);
        await expect(canvas.getByRole('alert')).toHaveTextContent((inputs.command.answer as { title: string }).title);
        await expect(canvas.queryByRole('link', { name: words.openYours[locale] })).toBeNull();
        await expect(canvasElement.textContent).not.toContain(inputs.answer.realm);
      } else {
        await waitFor(() => expect(navigation).toHaveBeenCalledWith(realmHref(locale, inputs.answer.realm.slice(-36))));
        await expect(inputs.answer.owner).toBe(inputs.body.actingSubject);
      }
      const writes = requests.filter(request => request.method !== 'GET');
      const creates = writes.filter(request => request.path === `${BFF_PREFIX}/v1/spaces`);
      for (const request of creates) await expect(request.body).toEqual(inputs.body);
      await expect(new Set(creates.map(request => request.key)).size).toBe(1);
      await expect(creates[0]?.key).toBeTruthy();
      await expect(writes.every(request => request.path === `${BFF_PREFIX}/v1/spaces`
        || (['created', 'replayed'].includes(state) && request.path === `${BFF_PREFIX}/v1/realms/${inputs.answer.realm.slice(-36)}/profile`))).toBe(true);
      if (!['created', 'replayed'].includes(state)) await expect(navigation).not.toHaveBeenCalled();
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
}

export const Stranger: Story = formStory('stranger');
export const Member: Story = formStory('member');
export const Owner: Story = formStory('owner');
export const Moderator: Story = formStory('moderator');
export const Operator: Story = formStory('operator');
export const ReplayedReceipt: Story = formStory('stranger', 'replayed');
export const Loading: Story = formStory('stranger', 'loading');
export const Pending202: Story = formStory('stranger', 'pending');
export const QuotaRefusal: Story = formStory('owner', 'quota');
export const IntentConflict: Story = formStory('stranger', 'conflict');
export const ExpiredSession: Story = formStory('stranger', 'expired');
export const RecoveredOwnRealm: Story = formStory('stranger', 'owned');
export const ModeratedHandleIsTaken: Story = formStory('stranger', 'taken');
export const NamesAndRules: Story = { ...Stranger,
  async play({ canvasElement, globals }) {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: words.addTranslation[locale] }));
    await userEvent.type(canvas.getByRole('textbox', { name: words.translationLanguage[locale] }), 'zh-Hans');
    await userEvent.type(canvas.getByRole('textbox', { name: words.translationName[locale] }), '读书圈');
    await userEvent.click(canvas.getByRole('button', { name: words.addRule[locale] }));
    await userEvent.type(canvas.getByRole('textbox', { name: words.ruleTitle[locale] }), 'Respect every reader');
    await userEvent.type(canvas.getByRole('textbox', { name: words.ruleBody[locale] }), 'Discuss the work and respect its original authors.');
    await expect(canvas.getByRole('textbox', { name: words.translationName[locale] })).toHaveValue('读书圈');
    await expect(canvas.getByRole('textbox', { name: words.ruleTitle[locale] })).toHaveValue('Respect every reader');
    await userEvent.click(canvas.getByRole('button', { name: words.removeRule[locale] }));
    await expect(canvas.queryByRole('textbox', { name: words.ruleTitle[locale] })).toBeNull();
    await expect(navigation).not.toHaveBeenCalled();
  } };
export const Phone: Story = { ...Stranger, globals: { viewport: { value: 'phone' } } };
export const PhoneLoading: Story = { ...Loading, globals: { viewport: { value: 'phone' } } };
export const PhonePending: Story = { ...Pending202, globals: { viewport: { value: 'phone' } } };
export const PhoneRefusal: Story = { ...QuotaRefusal, globals: { viewport: { value: 'phone' } } };
export const Visitor: Story = { args: { signedIn: false, actingSubject: null },
  async play({ canvasElement, globals }) {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: words.signIn[locale] })).toHaveAttribute('href', expect.stringContaining('next='));
    await expect(canvas.queryByRole('textbox')).toBeNull();
  } };
export const NoEligibleAuthor: Story = { args: { actingSubject: null },
  async play({ canvasElement, globals }) {
    const locale = (globals.locale as UiLocale | undefined) ?? 'en';
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(words.agentNeeded[locale]);
    await expect(within(canvasElement).queryByRole('textbox')).toBeNull();
  } };
export const Chinese: Story = { ...Stranger, globals: { locale: 'zh-Hans' } };
export const TraditionalChinese: Story = { ...Stranger, globals: { locale: 'zh-Hant' } };
export const Japanese: Story = { ...Stranger, globals: { locale: 'ja' } };
export const Korean: Story = { ...Stranger, globals: { locale: 'ko' } };
export const German: Story = { ...Stranger, globals: { locale: 'de' } };
export const French: Story = { ...Stranger, globals: { locale: 'fr' } };
export const Spanish: Story = { ...Stranger, globals: { locale: 'es' } };
