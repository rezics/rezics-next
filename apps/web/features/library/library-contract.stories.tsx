import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { LibraryContractPage } from './library-contract-page.tsx';
import { messages } from './messages.ts';

const meta = {
  title: 'Library/Contract states', component: LibraryContractPage,
  args: { medium: 'visual-novels', persona: 'member', state: 'populated', locale: 'en' },
  parameters: { route: { pathname: '/en/library', search: '?shelf=reading' },
    docs: { description: { component: 'Unrecorded contract states. Requests cross the typed Main client and production Library reader/page. The fixture retains the original outcome Work metadata. library-contract-fixtures.ts lists the exact requests it serves for prove-phase recording.' } } },
  globals: { viewport: { value: 'desktop' } },
  render: args => <LibraryContractPage key={`${args.medium}:${args.state}:${args.persona}:${args.locale}`} {...args} />,
} satisfies Meta<typeof LibraryContractPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const } } };

async function openFirstProgress(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: 'Library' });
  const summaries = canvasElement.querySelectorAll('summary');
  const progress = [...summaries].find(summary => summary.textContent?.startsWith('Your progress'));
  if (!progress) throw new Error('Library has no reachable progress control');
  await userEvent.click(progress);
  return canvas;
}

export const Books: Story = {
  args: { medium: 'books' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    const titles = canvas.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
    await expect(titles).toEqual(['Original outcome series', 'Original outcome volume']);
    await expect(canvas.getByRole('link', { name: /^Continue/ })).toBeVisible();
  },
};
export const BooksPhone: Story = { ...Books, ...phone };
export const BookPrivateReview: Story = {
  args: { medium: 'books', persona: 'owner', state: 'private-review' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Original outcome volume' });
    await expect(canvas.getByText('Private review · Only you can see this imported review.')).toBeVisible();
    await expect(canvas.getByText('Original author — private imported reading note.')).toBeVisible();
  },
};
export const BookPrivateReviewPhone: Story = { ...BookPrivateReview, ...phone };

export const RepeatedRecipes: Story = {
  args: { medium: 'recipes', persona: 'owner' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 2, name: /private recipe collection/ });
    await expect(canvas.getAllByRole('heading', { level: 3, name: 'Original whole-recipe tracking fixture' })).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Select' }));
    const selections = canvas.getAllByRole('checkbox', { name: 'Select “Original whole-recipe tracking fixture”' });
    await userEvent.click(selections[1]!);
    await expect(selections[0]).not.toBeChecked();
    await expect(selections[1]).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Done' }));
    await openFirstProgress(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark reading' }));
    await expect(await canvas.findByText('Reading', { exact: true })).toBeVisible();
  },
};
export const RepeatedRecipesPhone: Story = { ...RepeatedRecipes, ...phone };

/** Intent remains Want to play after personal progress is completed and undone. */
export const GameIntent: Story = {
  args: { medium: 'games' },
  play: async ({ canvasElement }) => {
    const canvas = await openFirstProgress(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark playing' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark completed' }));
    await expect(await canvas.findByText('Completed', { exact: true })).toBeVisible();
    await expect(canvas.getAllByText('Want to play')).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Mark not started' }));
    await expect(await canvas.findByText('Not started', { exact: true })).toBeVisible();
  },
};
export const GameIntentPhone: Story = { ...GameIntent, ...phone };

/** The game control uses required parts for completion and preserves its bonus route. */
export const GameRequiredAndExtra: Story = {
  args: { medium: 'games' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    const progress = [...canvasElement.querySelectorAll('summary')].filter(summary => summary.textContent?.startsWith('Your progress'));
    await userEvent.click(progress[1]!);
    await canvas.findByRole('heading', { name: 'Your play' });
    await expect(canvasElement.querySelector('[data-required-parts]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-routes]')).not.toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Mark completed' }));
    await expect(await canvas.findByText('Completed', { exact: true })).toBeVisible();
    await expect(canvasElement.querySelector('[data-routes] [data-route-state="none"]')).not.toBeNull();
  },
};
export const GameRequiredAndExtraPhone: Story = { ...GameRequiredAndExtra, ...phone };

export const VisualNovelUndo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await openFirstProgress(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark completed' }));
    await expect(await canvas.findByText('Completed', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Mark not started' }));
    await expect(await canvas.findByText('Not started', { exact: true })).toBeVisible();
  },
};
export const VisualNovelUndoPhone: Story = { ...VisualNovelUndo, ...phone };
export const VisualNovelReplay: Story = { ...VisualNovelUndo, args: { state: 'replay' } };
export const VisualNovelReplayPhone: Story = { ...VisualNovelReplay, ...phone };
export const VisualNovelStaleWinner: Story = {
  args: { state: 'stale' },
  play: async ({ canvasElement }) => {
    const canvas = await openFirstProgress(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark completed' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Playing');
    await userEvent.click(canvas.getByRole('button', { name: 'Use the other version' }));
    await expect(await canvas.findAllByText('Playing', { exact: true }).then(items => items[0]!)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Mark completed' }));
    await expect(await canvas.findByText('Completed', { exact: true })).toBeVisible();
  },
};
export const VisualNovelStaleWinnerPhone: Story = { ...VisualNovelStaleWinner, ...phone };
export const Stranger: Story = { ...VisualNovelUndo, args: { persona: 'stranger' } };
export const Owner: Story = { ...VisualNovelUndo, args: { persona: 'owner' } };
export const Moderator: Story = { ...VisualNovelUndo, args: { persona: 'moderator' } };
export const Operator: Story = { ...VisualNovelUndo, args: { persona: 'operator' } };

export const SignedOut: Story = {
  args: { persona: 'visitor' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    await expect(canvas.queryByRole('button', { name: 'Mark completed' })).toBeNull();
    await expect(canvas.queryByRole('navigation', { name: 'Shelves' })).toBeNull();
  },
};
export const SignedOutPhone: Story = { ...SignedOut, ...phone };
export const Empty: Story = {
  args: { state: 'empty' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('heading', { name: 'Your library starts here' })).toBeVisible();
  },
};
export const EmptyPhone: Story = { ...Empty, ...phone };
export const Unavailable: Story = {
  args: { state: 'error' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toBeVisible();
    await expect(within(canvasElement).getByRole('link', { name: 'Try again' })).toBeVisible();
  },
};
export const UnavailablePhone: Story = { ...Unavailable, ...phone };
export const Loading: Story = {
  args: { state: 'loading' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent('Loading…');
  },
};
export const LoadingPhone: Story = { ...Loading, ...phone };

/** Only the admitted POST's HTTP 202 supplies pending; the Library reads remain ordinary completed reads. */
export const ImportPending: Story = {
  args: { medium: 'books', persona: 'owner', state: 'pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    await userEvent.click(canvas.getByText(messages.libraryTools, { selector: 'summary' }));
    await userEvent.click(canvas.getByRole('heading', { name: 'Import your books' }));
    await userEvent.click(await canvas.findByRole('button', { name: /^Continue/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Add to my library' }));
    await expect(await canvas.findByText('Adding to your library: 0 of 1')).toBeVisible();
    await expect(canvas.queryByText('Your import is complete.')).toBeNull();
  },
};
export const ImportPendingPhone: Story = { ...ImportPending, ...phone };

/** The Library page resumes its saved bound cursor after a lost export response. */
export const ExportResume: Story = {
  args: { medium: 'books', persona: 'owner', state: 'export-interrupted' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    await userEvent.click(canvas.getByText(messages.libraryTools, { selector: 'summary' }));
    await userEvent.click(canvas.getByRole('heading', { name: 'Download your library' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Download library' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Resume download' }));
    await expect(await canvas.findByText(/Your file is ready: 43 records/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save file' })).toBeVisible();
  },
};
export const ExportResumePhone: Story = { ...ExportResume, ...phone };
export const ExportChangedBasis: Story = {
  args: { medium: 'books', persona: 'owner', state: 'export-moved' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: 'Library' });
    await userEvent.click(canvas.getByText(messages.libraryTools, { selector: 'summary' }));
    await userEvent.click(canvas.getByRole('heading', { name: 'Download your library' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Download library' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Your library changed');
    await userEvent.click(canvas.getByRole('button', { name: 'Start over' }));
    await expect(await canvas.findByText(/Your file is ready: 43 records/)).toBeVisible();
  },
};
export const ExportChangedBasisPhone: Story = { ...ExportChangedBasis, ...phone };
