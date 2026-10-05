import { profileHref } from '../profile/route.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { resourceHref } from '../address/path.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { settled } from '../../../../packages/ui/src/stories/support.tsx';
import { focusForTyping } from '../../../../packages/ui/src/test/focus.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { ReviewsSection } from './reviews.tsx';
import { chooseOption } from '../stories/choose-option.ts';

const signedOut = {
  kind: 'signed-out' as const,
  signInHref: `/auth/start?next=%2Fen%2Fw%2F${fixture.workRef}`,
};
const reader = { kind: 'reader' as const, actingSubject: fixture.reviewReader, canWrite: true };

const meta = {
  title: 'Work page/Reviews',
  component: ReviewsSection,
  args: {
    target: fixture.work.id,
    context: fixture.reviewContext,
    scale: 5,
    initial: fixture.reviewPage(fixture.reviews),
    reviewers: fixture.reviewers,
    viewer: signedOut,
    locale: 'en',
    messages: messages.en,
  },
  decorators: [
    (Story, { args }) => (
      <ReaderActionsProvider
        signedIn={args.viewer.kind !== 'signed-out'}
        signInHref={signedOut.signInHref}
        actions={
          args.viewer.kind === 'reader'
            ? memoryReaderActions({ [fixture.work.id]: { rating: 4 } })
            : undefined
        }
      >
        <div className="mx-auto max-w-3xl p-6">
          <Story />
        </div>
      </ReaderActionsProvider>
    ),
  ],
  parameters: { route: { pathname: localizedPath(resourceHref('/w/', fixture.workRef), 'en') } },
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
    await expect(within(reviews[0]!).getByRole('link', { name: 'Aria Wang' })).toHaveAttribute(
      'href',
      localizedPath(profileHref('aria'), 'en'),
    );
    await expect(reviews[0]).toHaveTextContent('Rated 5 out of 5');
    await expect(reviews[0]).toHaveTextContent('41 people found this helpful');
    // Spoilers wait behind a gate.
    await expect(reviews[1]).toHaveTextContent('This review gives away the story.');
    await expect(reviews[2]).toHaveTextContent('Simplified Chinese');
    // Signed out, writing and voting lead to sign-in.
    await expect(canvas.getByRole('link', { name: /Write a review/ })).toHaveAttribute(
      'href',
      signedOut.signInHref,
    );
    await expect(within(reviews[0]!).getByRole('link', { name: /Helpful/ })).toHaveAttribute(
      'href',
      signedOut.signInHref,
    );
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
    await expect(canvas.getByRole('button', { name: 'Newest' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => expect(canvas.getAllByRole('article')[0]).toHaveTextContent('林梅'));
    await userEvent.click(canvas.getByRole('combobox', { name: 'Rating' }));
    await chooseOption(within(document.body), '1 star');
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
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Your review' }),
      'A patient, tidal book.',
    );
    await userEvent.click(within(form).getByRole('checkbox', { name: 'It gives away the story' }));
    // Nothing says which language this is until the writer does; the interface language is English.
    await expect(
      within(form).getByRole('button', { name: 'Review language: Language not specified' }),
    ).toBeVisible();
    await userEvent.click(within(form).getByRole('button', { name: /^Review language:/ }));
    // The choices sit in a dialog that makes the page behind it inert. Wait until
    // that dialog has finished opening, then search and choose inside it.
    const dialog = await settled(
      await within(document.body).findByRole('dialog', { name: 'Review language' }),
    );
    await waitFor(() => expect(dialog).toHaveAttribute('data-state', 'open'));
    const search = within(dialog).getByRole('searchbox');
    await focusForTyping(search);
    await userEvent.type(search, 'korean');
    await userEvent.click(await within(dialog).findByRole('button', { name: /한국어/ }));
    await expect(within(form).getByRole('textbox', { name: 'Your review' })).toHaveAttribute(
      'lang',
      'ko',
    );
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
  args: {
    viewer: reader,
    api: fixture.memoryReviewApi([fixture.ownReview, ...fixture.reviews]),
    initial: fixture.reviewPage([fixture.ownReview, ...fixture.reviews]),
  },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const api = args.api as ReturnType<typeof fixture.memoryReviewApi>;
    const own = canvas.getByRole('article', { name: 'Your review' });
    await expect(own).toHaveTextContent('edited');
    await userEvent.click(within(own).getByRole('button', { name: 'Edit your review' }));
    const form = canvas.getByRole('form', { name: 'Edit your review' });
    await expect(within(form).getByRole('textbox', { name: 'Your review' })).toHaveValue(
      'Slow at first, then impossible to put down.',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Delete review' }));
    await expect(form).toHaveTextContent('Delete your review? Your rating stays.');
    await userEvent.click(within(form).getAllByRole('button', { name: 'Delete review' }).at(-1)!);
    await waitFor(() => expect(api.calls.some((call) => call.startsWith('remove:'))).toBe(true));
    await waitFor(() => expect(canvas.queryByRole('article', { name: 'Your review' })).toBeNull());
  },
};

export const RealmReadOnly: Story = {
  args: {
    viewer: { ...reader, canWrite: false },
    scale: 10,
    api: fixture.memoryReviewApi(),
    initial: fixture.reviewPage(
      fixture.reviews.map((review) => ({
        ...review,
        rating: review.rating === null ? null : review.rating * 2,
      })),
    ),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // A community's ten-point question keeps its scale; writing happens from everyone's view.
    await expect(canvas.getAllByRole('article')[0]).toHaveTextContent('Rated 10 out of 10');
    await expect(canvas.queryByRole('button', { name: 'Write a review' })).toBeNull();
  },
};

export const Unscored: Story = {
  args: {
    initial: fixture.reviewPage(
      fixture.reviews.map((review) => ({
        ...review,
        rating: null,
        ratingObservation: null,
        ratingRevision: null,
      })),
    ),
    api: fixture.memoryReviewApi(),
  },
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
  decorators: [
    (Story) => {
      window.history.replaceState(null, '', '#review-9a8b7c6d-5e4f-4a3b-8c2d-000000000009');
      return <Story />;
    },
  ],
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

export const OfAnotherResource: Story = {
  args: {
    target: 'https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d',
    href: '/v1/resources/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d/reviews',
    subject: 'Reviews of this release',
    viewer: { kind: 'read-only' },
    api: fixture.memoryReviewApi(),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // The heading says what was reviewed, and a target without its own rating question offers no writing or voting.
    await expect(canvas.getByText('Reviews of this release')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Write a review' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: /Write a review/ })).toBeNull();
    await expect(canvas.queryAllByRole('button', { name: 'Helpful' })).toHaveLength(0);
    await expect(canvas.getAllByRole('article')).toHaveLength(3);
  },
};

const grainTargets = [
  { grain: 'story' as const, target: fixture.work.id, label: 'Sword Art Online' },
  {
    grain: 'edition' as const,
    target: 'https://rezics.com/id/0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d',
    label: 'Sword Art Online 1: Aincrad · Yen Press · 2014',
  },
  {
    grain: 'translation' as const,
    target: 'https://rezics.com/id/1c0f5e3b-7d2a-4f9c-b4e6-8a3d0f2c5b7e',
    label: 'English · Translation',
  },
  {
    grain: 'related' as const,
    target: 'https://rezics.com/id/2d1a6f4c-8e3b-4a0d-85f7-9b4e1a3d6c8f',
    label: 'Aincrad (manga)',
  },
];
const aggregate = (grain: string, count: number, mean: number | null) => ({
  question: 'How good is this edition?',
  grain,
  population: 'account-principal',
  countedTarget: grainTargets[1]!.target,
  count,
  mean,
  scale: { min: 1, max: 10 },
});

/** What the reviews are of is the reader's choice, and each choice states the scope of its own aggregate. */
export const ByGrain: Story = {
  args: {
    api: fixture.memoryReviewApi(),
    targets: grainTargets,
    scopeQuery: {
      scope: 'realm',
      realm: 'https://rezics.com/id/3e2b7a5d-9f4c-4b1e-96a8-0c5f2b4e7d90',
    },
    aggregate: {
      ...aggregate('main-version', 12, 8.5),
      question: 'How good is this story or adaptation?',
      countedTarget: 'https://rezics.com/id/4f3c8b6e-0a5d-4c2f-a7b9-1d6a3c5f8e01',
    },
    grainReader: async (target) =>
      target === grainTargets[3]!.target
        ? { kind: 'no-question' }
        : {
            kind: 'ready',
            context: fixture.reviewContext,
            scale: 10,
            aggregate: aggregate('release', 3, 8),
            reviews: fixture.reviewPage(fixture.reviews),
          },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // The Work's own reviews first, counted per Main Version.
    await expect(canvas.getByText(/story \(Main Version\)/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: grainTargets[1]!.label }));
    await waitFor(() => expect(canvas.getByText(/edition \(release\)/)).toBeVisible());
    // The section is drawn again for the chosen target, so the choice is looked up again.
    await expect(canvas.getByRole('button', { name: grainTargets[1]!.label })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      canvas.getByText('Reviews of Sword Art Online 1: Aincrad · Yen Press · 2014'),
    ).toBeVisible();
    // A related Work with no rating question in this scope says so instead of borrowing another's reviews.
    await userEvent.click(canvas.getByRole('button', { name: 'Aincrad (manga)' }));
    await waitFor(() =>
      expect(canvas.getByText(/No rating question covers this here/)).toBeVisible(),
    );
    await expect(canvas.queryAllByRole('article')).toHaveLength(0);
    // The story is one choice away.
    await userEvent.click(canvas.getByRole('button', { name: 'Sword Art Online' }));
    await waitFor(() => expect(canvas.getByText(/story \(Main Version\)/)).toBeVisible());
  },
};

export const ByGrainPhone: Story = {
  ...ByGrain,
  args: { ...ByGrain.args, locale: 'zh-Hant', messages: messages['zh-Hant'] },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
