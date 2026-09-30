import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { ReviewsSection } from './reviews.tsx';

const signedOut = { kind: 'signed-out' as const, signInHref: `/auth/start?next=%2Fen%2Fw%2F${fixture.workRef}` };
const reader = { kind: 'reader' as const, actingSubject: fixture.reviewReader, canWrite: true };

const meta = {
  title: 'Work page/Reviews',
  component: ReviewsSection,
  args: { work: fixture.work.id, context: fixture.reviewContext, scale: 5, initial: fixture.reviewPage(fixture.reviews),
    reviewers: fixture.reviewers, viewer: signedOut, locale: 'en', messages: messages.en },
  decorators: [(Story, { args }) => <ReaderActionsProvider signedIn={args.viewer.kind !== 'signed-out'}
    signInHref={signedOut.signInHref} actions={args.viewer.kind === 'reader'
      ? memoryReaderActions({ [fixture.work.id]: { rating: 4 } }) : undefined}>
    <div className="mx-auto max-w-3xl p-6"><Story /></div>
  </ReaderActionsProvider>],
  parameters: { route: { pathname: `/en/w/${fixture.workRef}` } },
} satisfies Meta<typeof ReviewsSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  args: { api: fixture.memoryReviewApi() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const reviews = canvas.getAllByRole('article');
    await expect(reviews).toHaveLength(3);
    // Who wrote it, their stars and when, then the text.
    await expect(within(reviews[0]!).getByRole('link', { name: 'Aria Wang' })).toHaveAttribute('href', '/en/@aria');
    await expect(reviews[0]).toHaveTextContent('Rated 5 out of 5');
    await expect(reviews[0]).toHaveTextContent('41 people found this helpful');
    // Spoilers wait behind a gate.
    await expect(reviews[1]).toHaveTextContent('This review gives away the story.');
    await expect(reviews[2]).toHaveTextContent('Simplified Chinese');
    // Signed out, writing and voting lead to sign-in.
    await expect(canvas.getByRole('link', { name: /Write a review/ })).toHaveAttribute('href', signedOut.signInHref);
    await expect(within(reviews[0]!).getByRole('link', { name: /Helpful/ })).toHaveAttribute('href', signedOut.signInHref);
  },
};

export const ShowSpoilers: Story = {
  args: { api: fixture.memoryReviewApi() },
  async play({ canvasElement }) {
    const review = within(canvasElement).getAllByRole('article')[1]!;
    await userEvent.click(within(review).getByRole('button', { name: 'Show it' }));
    await waitFor(() => expect(review).toHaveTextContent(fixture.spoilerText));
    await expect(review).toHaveTextContent('Spoilers');
  },
};

export const SortAndFilter: Story = {
  args: { api: fixture.memoryReviewApi() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as ReturnType<typeof fixture.memoryReviewApi>;
    await userEvent.click(canvas.getByRole('button', { name: 'Newest' }));
    await waitFor(() => expect(api.calls).toContain('page:new:::'));
    await expect(canvas.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(canvas.getAllByRole('article')[0]).toHaveTextContent('林梅'));
    await userEvent.click(canvas.getByRole('combobox', { name: 'Rating' }));
    await userEvent.click(within(document.body).getByRole('option', { name: '1 star' }));
    await waitFor(() => expect(canvas.getByText('No reviews match these filters')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(3));
  },
};

export const HelpfulVote: Story = {
  args: { viewer: reader, api: fixture.memoryReviewApi() },
  async play({ canvasElement }) {
    const review = within(canvasElement).getAllByRole('article')[0]!;
    const helpful = within(review).getByRole('button', { name: 'Helpful' });
    await expect(helpful).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(helpful);
    await waitFor(() => expect(helpful).toHaveAttribute('aria-pressed', 'true'));
    await expect(review).toHaveTextContent('42 people found this helpful');
  },
};

export const WriteReview: Story = {
  args: { viewer: reader, api: fixture.memoryReviewApi() },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as ReturnType<typeof fixture.memoryReviewApi>;
    await userEvent.click(canvas.getByRole('button', { name: 'Write a review' }));
    const form = canvas.getByRole('form', { name: 'Write a review' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Your review' }), 'A patient, tidal book.');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'It gives away the story' }));
    // Nothing says which language this is until the writer does; the interface language is English.
    await expect(within(form).getByRole('button', { name: 'Review language: Language not specified' })).toBeVisible();
    await userEvent.click(within(form).getByRole('button', { name: /^Review language:/ }));
    await userEvent.type(await within(document.body).findByRole('searchbox'), 'korean');
    await userEvent.click(await within(document.body).findByRole('button', { name: /한국어/ }));
    await expect(within(form).getByRole('textbox', { name: 'Your review' })).toHaveAttribute('lang', 'ko');
    await userEvent.click(within(form).getByRole('button', { name: 'Post review' }));
    await waitFor(() => expect(api.calls).toContain('write:new:ko:true'));
    // The reader's own review leads the list, with Edit instead of Helpful.
    const own = await canvas.findByRole('article', { name: 'Your review' });
    await expect(own).toHaveTextContent('A patient, tidal book.');
    await expect(within(own).getByRole('button', { name: 'Edit your review' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Write a review' })).toBeNull();
  },
};

export const EditAndDelete: Story = {
  args: { viewer: reader, api: fixture.memoryReviewApi([fixture.ownReview, ...fixture.reviews]),
    initial: fixture.reviewPage([fixture.ownReview, ...fixture.reviews]) },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as ReturnType<typeof fixture.memoryReviewApi>;
    const own = canvas.getByRole('article', { name: 'Your review' });
    await expect(own).toHaveTextContent('edited');
    await userEvent.click(within(own).getByRole('button', { name: 'Edit your review' }));
    const form = canvas.getByRole('form', { name: 'Edit your review' });
    await expect(within(form).getByRole('textbox', { name: 'Your review' }))
      .toHaveValue('Slow at first, then impossible to put down.');
    await userEvent.click(within(form).getByRole('button', { name: 'Delete review' }));
    await expect(form).toHaveTextContent('Delete your review? Your rating stays.');
    await userEvent.click(within(form).getAllByRole('button', { name: 'Delete review' }).at(-1)!);
    await waitFor(() => expect(api.calls.some(call => call.startsWith('remove:'))).toBe(true));
    await waitFor(() => expect(canvas.queryByRole('article', { name: 'Your review' })).toBeNull());
  },
};

export const RealmReadOnly: Story = {
  args: { viewer: { ...reader, canWrite: false }, scale: 10, api: fixture.memoryReviewApi(),
    initial: fixture.reviewPage(fixture.reviews.map(review => ({ ...review,
      rating: review.rating === null ? null : review.rating * 2 }))) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A community's ten-point question keeps its scale; writing happens from everyone's view.
    await expect(canvas.getAllByRole('article')[0]).toHaveTextContent('Rated 10 out of 10');
    await expect(canvas.queryByRole('button', { name: 'Write a review' })).toBeNull();
  },
};

export const Unscored: Story = {
  args: { initial: fixture.reviewPage(fixture.reviews.map(review => ({ ...review,
    rating: null, ratingObservation: null, ratingRevision: null }))), api: fixture.memoryReviewApi() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('article')).toHaveLength(3);
    await expect(canvas.getByRole('link', { name: 'Aria Wang' })).toBeVisible();
    for (const review of canvas.getAllByRole('article')) {
      await expect(review).not.toHaveTextContent(/Rated|null|0 out of/);
    }
    await expect(canvas.getByText(/The best novel about maps I have read/)).toBeVisible();
  },
};

export const Empty: Story = {
  args: { initial: fixture.reviewPage([]), api: fixture.memoryReviewApi([]) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('No reviews yet')).toBeVisible();
  },
};

export const Unavailable: Story = {
  args: { initial: { ok: false, failure: 'unavailable' }, api: fixture.memoryReviewApi() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Reviews couldn’t load');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(3));
  },
};

/** The home feed links a review card to `#review-{id}`; one past the first page is read on its own and shown first. */
export const FollowedReviewLink: Story = {
  args: { api: fixture.memoryReviewApi() },
  decorators: [Story => {
    window.history.replaceState(null, '', '#review-9a8b7c6d-5e4f-4a3b-8c2d-000000000009');
    return <Story />;
  }],
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const linked = await canvas.findByText('A review from further down the list.');
    const card = linked.closest('article')!;
    await expect(card).toHaveAttribute('id', 'review-9a8b7c6d-5e4f-4a3b-8c2d-000000000009');
    await expect(canvas.getAllByRole('article')[0]).toBe(card);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  },
};

export const ChinesePhone: Story = {
  args: { api: fixture.memoryReviewApi(), locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
