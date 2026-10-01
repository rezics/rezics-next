import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { SearchInput, SearchState } from './intake.ts';
import { actingSubject, createdWork, found, scriptedPort, series } from './fixtures.ts';
import { IntakeWizard } from './intake-wizard.tsx';

const meta = { title: 'Catalogue intake/Wizard', component: IntakeWizard,
  parameters: { route: { pathname: '/en/catalogue/new' } },
  args: { actingSubject, locale: 'en', debounceMs: 0, port: scriptedPort(),
    types: [{ type: 'https://schema.org/Book', label: 'Book' }] },
  render: args => <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8"><IntakeWizard {...args} /></div>,
} satisfies Meta<typeof IntakeWizard>;
export default meta;
type Story = StoryObj<typeof meta>;

const noOverflow = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const createButton = 'Add something new';

/** Typing in Japanese, romaji or English offers the existing records; nothing offers to create until they are shown. */
export const SearchesFirst: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: createButton })).toBeNull();
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'ソードアート・オンライン');
    await expect(await canvas.findByText('3 existing records found')).toBeVisible();
    const list = canvas.getByRole('list', { name: 'Existing records' });
    await expect(within(list).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual(['Sword Art Online', 'Sword Art Online, Vol. 1', 'Sword Art Online: Progressive']);
    await expect(within(list).getAllByText('Unverified')).toHaveLength(1);
    await expect(canvas.getAllByRole('link', { name: 'Use this record' })).toHaveLength(3);
    await noOverflow();
  },
};

/**
 * Class guard: "Add something new" is not reachable before the search for exactly what is typed has
 * returned. It is absent while the search runs, and gone again the moment the text changes.
 */
export const CreateWaitsForTheSearch: Story = {
  render: args => {
    const held = new Map<string, (state: SearchState) => void>();
    const port = scriptedPort({ search: input => new Promise<SearchState>(done => { held.set(input.text, done); }) });
    const answer = (text: string) => held.get(text)?.(found({ text, language: 'en', creator: '' }));
    return <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
      <IntakeWizard {...args} port={port} />
      <button type="button" data-testid="answer-sword" onClick={() => answer('Sword')}>answer Sword</button>
      <button type="button" data-testid="answer-sword-art" onClick={() => answer('Sword Art')}>answer Sword Art</button>
    </div>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword');
    await expect(await canvas.findByText('Searching…')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: createButton })).toBeNull();
    await userEvent.click(canvas.getByTestId('answer-sword'));
    await expect(await canvas.findByRole('button', { name: createButton })).toBeVisible();
    // Typing on makes that answer stale: creating is not offered until the new search returns.
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), ' Art');
    await waitFor(() => expect(canvas.queryByRole('button', { name: createButton })).toBeNull());
    await userEvent.click(canvas.getByTestId('answer-sword-art'));
    await expect(await canvas.findByRole('button', { name: createButton })).toBeVisible();
  },
};

/** Choosing "translation" of volume 1 asks Main where it goes and does not create a Work. */
export const TranslationOfVolumeOne: Story = {
  args: { port: scriptedPort() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword Art Online');
    const volume = (await canvas.findByRole('heading', { name: 'Sword Art Online, Vol. 1' })).closest('li')!;
    await userEvent.click(within(volume).getByRole('button', { name: 'Add a translation or edition' }));
    await expect(await canvas.findByText('Opening the page where this is added…')).toBeVisible();
    await expect((args.port as ReturnType<typeof scriptedPort>).calls).toContain('owner:translation-or-version');
    await expect((args.port as ReturnType<typeof scriptedPort>).calls).not.toContain('create');
  },
};

/** "Create" asks what the record is; a new story is created and shows as unverified with its provenance. */
export const CreateNewStory: Story = {
  args: { port: scriptedPort() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword Art Online Alternative');
    await userEvent.click(await canvas.findByRole('button', { name: createButton }));
    await expect(await canvas.findByRole('heading', { name: 'What are you adding?' })).toHaveFocus();
    await userEvent.click(canvas.getByRole('radio', { name: /A new story or series/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create record' }));
    const created = await canvas.findByRole('heading', { name: 'Record created' });
    await expect(created).toHaveFocus();
    await expect(canvas.getByText('Unverified')).toBeVisible();
    await userEvent.click(await canvas.findByText('Where these fields came from'));
    await expect(canvas.getByText('Title')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open the record' })).toHaveAttribute('href', `/en/w/${createdWork.slice(-36)}`);
    await expect((args.port as ReturnType<typeof scriptedPort>).calls).toContain('create');
    await noOverflow();
  },
};

/** The fourth pending creation: Main's limit is explained with its Retry-After. */
export const PendingLimit: Story = {
  args: { port: scriptedPort({ create: async () => ({ outcome: 'limit', retryAfter: 60 }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Fourth pending book');
    await userEvent.click(await canvas.findByRole('button', { name: createButton }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create record' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('Your records are waiting for review');
    await expect(alert).not.toHaveTextContent(/three|Main/i);
    await expect(alert).toHaveTextContent('60 seconds');
  },
};

/** A part of a series needs the series chosen from the results. */
export const PartNeedsASeries: Story = {
  args: { port: scriptedPort() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword Art Online 2');
    await userEvent.click(await canvas.findByRole('button', { name: createButton }));
    await userEvent.click(canvas.getByRole('radio', { name: /A part of a series/ }));
    const submit = canvas.getByRole('button', { name: 'Create record' });
    // The button stays available: a missing parent is a refusal tied to the choice, not a silent dead button.
    await userEvent.click(submit);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Choose the record this belongs to.');
    await expect(within(canvas.getByTestId('intake-parent')).getAllByRole('radio')[0]).toHaveFocus();
    await userEvent.click(within(canvas.getByTestId('intake-parent')).getByRole('radio', { name: 'Sword Art Online' }));
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
    await userEvent.click(submit);
    await expect(await canvas.findByRole('heading', { name: 'Record created' })).toHaveFocus();
    await expect((args.port as ReturnType<typeof scriptedPort>).calls).toContain(`create:${series.work}`);
    await expect(await canvas.findByRole('link', { name: 'Add it to Sword Art Online' })).toBeVisible();
  },
};

/** A collection is made in the library: no path is shown, the contributor is sent there. */
export const CollectionGoesToTheLibrary: Story = {
  args: { port: scriptedPort({ ownerApi: async () => ({ outcome: 'owner-api', method: 'POST', path: '/v1/collections' }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword Art Online shelf');
    await userEvent.click(await canvas.findByRole('button', { name: createButton }));
    await userEvent.click(canvas.getByRole('radio', { name: /A collection/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    await expect(await canvas.findByText('Opening the page where this is added…')).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent('/v1/');
  },
};

/** The write budget is not the pending limit, and a bad title language says what is wrong. */
export const RefusalsSayTheirOwnReason: Story = {
  args: { port: scriptedPort({ create: async () => ({ outcome: 'rate-limited', retryAfter: 30 }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Too quick');
    await userEvent.click(await canvas.findByRole('button', { name: createButton }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create record' }));
    const alert = await canvas.findByRole('alert');
    await expect(alert).toHaveTextContent('too quickly');
    await expect(alert).toHaveTextContent('30 seconds');
    await expect(alert).not.toHaveTextContent('waiting for review');
  },
};

/** An alias is saved onto the record found, with Main's refusal shown when the contributor may not. */
export const AddAnAlias: Story = {
  args: { saveAliasTo: async () => 'denied' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'SAO');
    const first = (await canvas.findByRole('heading', { name: 'Sword Art Online' })).closest('li')!;
    await userEvent.click(within(first).getByRole('button', { name: 'Add an alias' }));
    const form = canvas.getByRole('form', { name: 'Add an alias to Sword Art Online' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Alias' }), 'SAO');
    await userEvent.click(within(form).getByRole('button', { name: 'Save alias' }));
    await expect(await within(form).findByText(/can’t change this record’s names/)).toBeVisible();
  },
};

/** Nothing matched: the contributor is told so, and may then add something new. */
export const NothingFound: Story = {
  args: { port: scriptedPort({ search: async (input: SearchInput) => found(input, []) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'A brand new story');
    await expect(await canvas.findByText('Nothing matches yet.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: createButton })).toBeVisible();
  },
};

/** The catalogue cannot be reached: the contributor is told, and cannot create. */
export const SearchUnavailable: Story = {
  args: { port: scriptedPort({ search: async input => ({ phase: 'failed', input, reason: 'unavailable' }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: /Title, alias/ }), 'Sword Art Online');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('The search could not be completed');
    await expect(canvas.getByText('The catalogue could not be reached. Nothing was added.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: createButton })).toBeNull();
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans', initialText: 'Sword Art Online' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('找到 3 条已有记录')).toBeVisible();
    await noOverflow();
  } };
