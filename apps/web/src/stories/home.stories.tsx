import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Discovery/Home',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Default Home route and consumer using the shared FeedResults region. Illustrative feed envelopes composed from recorded native owner summaries; these stories are not native feed acceptance evidence. Locale, theme and phone/desktop viewport use the catalogue globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  name: 'Member, mixed ready',
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Letters from B-612' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull();
    await expect(canvas.getByRole('region', { name: m.nav_home() })).toBeVisible();
    await expect(canvas.getByRole('list', { name: m.nav_home() })).toBeVisible();
    await expect(context.canvasElement.querySelector('main main')).toBeNull();
    const nativeOrder = [...context.canvasElement.querySelectorAll('[data-feed-id]')].map((row) =>
      row.getAttribute('data-feed-source'),
    );
    await expect(nativeOrder).toEqual(['discovery', 'following', 'continue']);
    await userEvent.click(canvas.getByRole('button', { name: m.library_next_page() }));
    await waitFor(() =>
      expect(context.canvasElement.ownerDocument.activeElement).toBe(
        canvas.getByRole('region', { name: m.nav_home() }),
      ),
    );
    await expect(canvas.queryByRole('button', { name: m.library_next_page() })).toBeNull();
  },
};
export const SignedOut: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    await expect(context.canvasElement.querySelector('[data-feed-source="discovery"]')).not.toBeNull();
    await expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).toBeNull();
    await expect(within(context.canvasElement).queryByRole('button', { name: m.home_feed_following() })).toBeNull();
  },
};
export const PartialSources: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="partial" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Letters from B-612' })).toBeVisible();
    await expect(await canvas.findByText(m.home_presentation_partial())).toBeVisible();
    await waitFor(() => expect(canvas.getAllByRole('status')).toHaveLength(1));
    const retry = canvas.getByRole('button', { name: m.library_follow_retry() });
    await expect(retry).toBeEnabled();
    await userEvent.click(retry);
    await expect(await canvas.findByRole('link', { name: 'Letters from B-612' })).toBeVisible();
    await expect(canvas.getByText(m.home_presentation_partial())).toBeVisible();
  },
};
export const Preparing: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="preparing" />,
  play: pageReady,
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="unavailable" />,
  play: pageReady,
};
export const Empty: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="empty" />,
  play: pageReady,
};
export const Following: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const { userEvent } = await import('storybook/test');
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    const following = await canvas.findByRole('button', { name: m.home_feed_following() });
    await expect(following).toBeEnabled();
    await userEvent.click(following);
    await expect(await canvas.findByRole('link', { name: 'Books I come back to' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-feed-source="discovery"]')).toBeNull();
  },
};

export const KindSelection: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="schema:Book"]'),
      ).not.toBeNull(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
    await userEvent.click(canvas.getByRole('button', { name: m.search_close_filters() }));
    await expect(canvas.getByRole('list', { name: m.refinement_selected() })).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.search_filters() })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull());
    await expect(canvas.queryByRole('link', { name: 'Letters from B-612' })).toBeNull();
  },
};
export const KindChoicesUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="kinds-unavailable" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await expect(await canvas.findByText(m.home_kinds_unavailable())).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Letters from B-612' })).toBeVisible();
  },
};
export const KindChoicesNextPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="kinds-next" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="schema:Book"]'),
      ).not.toBeNull(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await waitFor(() => expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: m.home_kinds_next() }));
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="account"]'),
      ).not.toBeNull(),
    );
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
  },
};

// Interactive source stories: use the actual exact-address control; no synthetic native-proof claim.
export const SpaceSelection: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up home-reading-room, review its current title/address, then use the Space. Next, retry, refresh and clear use the default Home consumer.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-selection" />,
};
export const SpaceUnavailable: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up home-reading-room. Its illustrative native point response has no readable Realm; it cannot be selected or treated as an empty feed.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-unavailable" />,
};
export const SpaceIdentityChanged: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up and select home-reading-room, then refresh. The Realm changes independently while the head remains equal, retiring the displayed page and cursor.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-identity-changed" />,
};

export const QuestionSelection: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Load questions and select a returned question. The actual default consumer refreshes its identity, reads the selected feed, and supports clear and refresh. Envelopes are illustrative, not native evidence.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="questions-selection" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(canvas.getByRole('button', { name: m.home_questions_load() }));
    const select = canvas.getByRole('combobox', { name: m.home_question_label() });
    const questionId = '00000000-0000-7000-8000-000000000001';
    await waitFor(() => expect(select.querySelector(`option[value="${questionId}"]`)).not.toBeNull());
    await userEvent.selectOptions(select, questionId);
    await waitFor(() => expect(context.canvasElement.querySelector('main[aria-busy="false"]')).not.toBeNull());
    const selected = canvas.getByRole('list', { name: m.refinement_selected() });
    await expect(selected).toHaveTextContent('Overall impression');
    await userEvent.click(canvas.getByRole('button', { name: m.search_close_filters() }));
    await expect(selected).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    const summary = canvas.getByText(m.home_presentation_question_information());
    const details = summary.closest('details')!;
    await expect(details).not.toHaveAttribute('open');
    const information = details.querySelector('p')!;
    await expect(information).not.toBeVisible();
    await userEvent.click(summary);
    await expect(information).toBeVisible();
    await expect(information).toHaveTextContent(m.home_question_work());
    await expect(information).toHaveTextContent('Overall impression');
    await expect(information).toHaveTextContent('100');
  },
};
export const QuestionChoicesUnavailable: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Load questions to see the unavailable response and retry action while the existing mixed Home remains usable.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="questions-unavailable" />,
};
export const QuestionChoicesNextPage: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Load and select a question, then request the next directory page. The page is replaced while the selected metadata remains. The real next/null frontier controls continuation.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="questions-next" />,
};

export const QuestionSelectionLost: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="question-lost" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(canvas.getByRole('button', { name: m.home_questions_load() }));
    const select = canvas.getByRole('combobox', { name: m.home_question_label() });
    const questionId = '00000000-0000-7000-8000-000000000001';
    await waitFor(() => expect(select.querySelector(`option[value="${questionId}"]`)).not.toBeNull());
    await userEvent.selectOptions(select, questionId);
    await expect(await canvas.findByText(m.home_questions_lost())).toBeVisible();
    await expect(canvas.getByRole('list', { name: m.refinement_selected() })).toHaveTextContent('Overall impression');
    await expect(canvas.getAllByRole('alert')).toHaveLength(1);
    await expect(canvas.queryByText(m.home_feed_unavailable())).toBeNull();
    await expect(canvas.getByRole('button', { name: m.home_question_refresh() })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: m.home_question_clear() })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.home_question_clear() }));
    await expect(canvas.queryByRole('list', { name: m.refinement_selected() })).toBeNull();
  },
};

export const ExpiredPageRecovery: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="expired-page" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await userEvent.click(canvas.getByRole('button', { name: m.home_kinds_load() }));
    const kind = canvas.getByRole('combobox', { name: m.home_kind_label() });
    await waitFor(() => expect(kind.querySelector('option[value="schema:Book"]')).not.toBeNull());
    await userEvent.selectOptions(kind, 'schema:Book');
    await userEvent.click(canvas.getByRole('button', { name: m.search_close_filters() }));
    const selected = canvas.getByRole('list', { name: m.refinement_selected() });
    const selectedLabel = kind.querySelector<HTMLOptionElement>('option:checked')!.textContent!;
    await expect(selected).toHaveTextContent(selectedLabel);
    await userEvent.click(canvas.getByRole('button', { name: m.library_next_page() }));
    await expect(await canvas.findByText(m.home_feed_cursor())).toBeVisible();
    await expect(m.home_feed_cursor()).not.toMatch(/cursor/i);
    await userEvent.click(canvas.getByRole('button', { name: m.home_feed_restart() }));
    await expect(await canvas.findByRole('link', { name: 'Letters from B-612' })).toBeVisible();
    await expect(selected).toHaveTextContent(selectedLabel);
    await userEvent.click(canvas.getByRole('button', { name: m.search_filters() }));
    await expect(kind).toHaveValue('schema:Book');
  },
};

export const SparseContinuation: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="sparse" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.home_feed_sparse())).toBeVisible();
    await expect(canvas.queryByText(m.home_feed_empty())).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_next_page() }));
    await expect(await canvas.findByRole('link', { name: 'Books I come back to' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_next_page() })).toBeNull();
  },
};
