import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { messages } from './messages.ts';
import { choices, memoryWelcome } from './welcome-fixtures.ts';
import { WelcomeFlow, type WelcomeFlowProps } from './welcome-flow.tsx';

// A new reader's first minute over an in-memory Main: languages, topics by
// type with covers (each becomes a pinned Home tab), then communities, all
// followed in one command. Every step can be skipped.

const reader = 'https://rezics.com/id/00000801-bbbb-4a6f-8c2d-3e7b5c1a9f40';

function props(change: Partial<WelcomeFlowProps> = {}): WelcomeFlowProps {
  return { locale: 'en', messages: messages.en, actingSubject: reader, avatarQuery: '', choices, savedLanguages: null,
    next: '/en', api: memoryWelcome(), ...change };
}

const meta = {
  title: 'Onboarding/Setup',
  component: WelcomeFlow,
  parameters: { route: { pathname: '/en/welcome' } },
  globals: { viewport: { value: 'desktop' } },
  decorators: [Story => <div className="mx-auto max-w-4xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof WelcomeFlow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Languages from the locale, topics that become tabs, then suggested communities followed in one step. */
export const ChooseEverything: Story = {
  args: props(),
  async play({ canvasElement, args }) {
    const api = args.api as ReturnType<typeof memoryWelcome>;
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Step 1 of 3')).toBeVisible();
    // Languages are an ordered list, the locale's first; any language can join it by name or code.
    const chosen = canvas.getByRole('region', { name: 'Your languages, first choice first' });
    await expect(within(chosen).getAllByRole('listitem').map(item => item.textContent)).toEqual(['1English']);
    await userEvent.click(canvas.getByRole('button', { name: 'Add Japanese' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Add another language' }), 'brazil');
    await userEvent.click(await canvas.findByRole('button', { name: 'Add Brazilian Portuguese' }));
    await userEvent.click(within(chosen).getByRole('button', { name: 'Move Brazilian Portuguese up' }));
    await expect(within(chosen).getAllByRole('listitem').map(item => item.textContent?.slice(0, 1))).toEqual(['1', '2', '3']);
    await expect(within(chosen).getAllByRole('listitem')[1]).toHaveTextContent('português');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));

    await expect(canvas.getByRole('heading', { level: 2, name: 'Pick a few topics' })).toBeVisible();
    // Topics come by type, with examples; a book series shares the books' group.
    const books = canvas.getByRole('region', { name: 'Books & novels' });
    await expect(within(books).getAllByRole('button')).toHaveLength(4);
    await expect(canvas.getByRole('region', { name: 'Games' })).toBeVisible();
    await expect(within(books).getByRole('button', { name: /仙侠/ })).toHaveTextContent('in Fantasy');
    await userEvent.click(within(books).getByRole('button', { name: /^Fantasy/ }));
    await userEvent.click(within(canvas.getByRole('region', { name: 'Games' })).getByRole('button', { name: /Cozy games/ }));
    await expect(canvas.getByRole('status')).toHaveTextContent('2 of 8 chosen');
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));

    const communities = await canvas.findByRole('list', { name: 'Follow a few communities' });
    await expect(api.calls).toContain('suggestions:2:en,pt-BR,ja');
    // Every suggestion starts ticked, with its reason; the reader unticks what they do not want.
    await expect(within(communities).getByText(/For Farming sims · 12,480 members/)).toBeVisible();
    await userEvent.click(within(communities).getByRole('button', { name: /Classic Literature/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Follow 2 and finish' }));
    await waitFor(() => expect(api.calls).toContain('follow:concept,concept,realm,zone'));
    await expect(api.calls).toContain('languages:en,pt-BR,ja');
  },
};

/** Skipping every step changes no setting and follows nothing; Home keeps a slim invitation. */
export const SkipEachStep: Story = {
  args: props(),
  async play({ canvasElement, args }) {
    const api = args.api as ReturnType<typeof memoryWelcome>;
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Skip' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Skip' }));
    await canvas.findByRole('list', { name: 'Follow a few communities' });
    await expect(api.calls).toContain('suggestions:0:');
    await userEvent.click(canvas.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(document.cookie).toContain('rezics_home_picker=skipped'));
    await expect(api.calls.some(call => call.startsWith('languages:'))).toBe(false);
  },
};

/** Eight topics fill Home's tabs: the rest wait until one is unpicked. */
export const EightTopics: Story = {
  args: props({ initialStep: 2, choices: { ...choices, groups: [{ type: 'https://schema.org/Book',
    concepts: Array.from({ length: 10 }, (_, index) => ({ ...choices.groups[0]!.concepts[0]!,
      id: `https://rezics.com/id/00000${400 + index}-eeee-4a6f-8c2d-3e7b5c1a9f40`,
      name: { ...choices.groups[0]!.concepts[0]!.name, value: `Topic ${index + 1}` } })) }] } }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (let index = 1; index <= 8; index++) await userEvent.click(canvas.getByRole('button', { name: new RegExp(`Topic ${index}$`) }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Eight topics fill');
    await expect(canvas.getByRole('button', { name: /Topic 9$/ })).toBeDisabled();
  },
};

/** Main could not save: the choices stay and the reader can try again. */
export const SaveFailed: Story = {
  args: props({ initialStep: 3, api: memoryWelcome({ refuse: true }) }),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Skip' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Couldn’t save your choices');
  },
};

export const Chinese: Story = {
  args: props({ locale: 'zh-Hans', messages: messages['zh-Hans'], initialStep: 2 }),
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/welcome' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('region', { name: '图书与小说' })).toBeVisible();
  },
};

export const PhoneDark: Story = {
  args: props({ initialStep: 2 }),
  globals: { viewport: { value: 'phone' }, theme: 'dark' },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
