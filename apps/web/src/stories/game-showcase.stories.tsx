import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { game, gameSparse, gameReleases, gameSummary } from '../kernel/fixtures/game-showcase';
import { selectGameShowcase, type GameShowcaseState } from '../kernel/fake/game-showcase';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref, subjectUrlForView } from '../subject/subject-href';
import { PageStory } from './page';

function GameShowcase({ state = 'rich', entry = 'work' }: { state?: GameShowcaseState; entry?: 'work' | 'release' }) {
  const locale = getLocale();
  useMemo(() => selectGameShowcase(state), [state, entry, locale]);
  const id = entry === 'release' ? gameReleases[1]!.id : state === 'sparse' ? gameSparse.id : game.id;
  const summary = gameSummary(id, locale);
  const address = subjectHref({ id, label: summary.label.value }, locale);
  return (
    <PageStory
      key={`${state}:${entry}:${locale}`}
      visitor="Signed In"
      previewNewTabs
      path={entry === 'release' ? subjectUrlForView(address, 'release') : address.href}
      ratingsFixture={state === 'sparse' ? 'subject-ratings-empty' : 'subject-ratings-global'}
    />
  );
}

const meta = {
  title: 'Library/Games',
  id: 'pages-library-games',
  component: GameShowcase,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Canonical Game product visit through PageStory’s generated application route tree, shell and providers. Harbour Lights, its catalogue, reviews and local cover illustrations are synthetic CC0 examples, not provider recordings or native acceptance. All installed tabs and linked release, creator, character, related-work, review and collection destinations use the ordinary loaders. Personal library and score changes read back for the mounted visit. New-tab destinations stay in this preview’s existing router so work/release return and browser history can be reviewed manually. These entries stay at their named state; theme, locale and viewport remain global controls. The original [Game work and exact release URL](?path=/story/pages-catalogue-game-reader--work-and-exact-release) mounts this same ordinary visit, with optional Editions and evidence closed initially. Isolated reader example: [Game work facts](?path=/story/pages-catalogue-game-reader--reader-work-facts). Existing interaction examples: [Game recovery](?path=/story/pages-catalogue-game-reader-recovery--inspect-and-revisit) and [current assertion](?path=/story/pages-catalogue-game-current-assertion-visit--selected-current-evidence). Mounted, keyboard, responsive and deployed acceptance runs separately in the dev verifier.',
      },
    },
  },
} satisfies Meta<typeof GameShowcase>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Main: Story = {};
export const ExactReleaseReturn: Story = {
  args: { entry: 'release' },
  parameters: {
    docs: {
      description: {
        story:
          'Starts on the exact Switch game-card release. Follow its disclosed work to Harbour Lights, open Editions on demand, and open the same release. Release comparison and qualifier/citation details are separate disclosures. Back/Forward uses PageStory’s application history.',
      },
    },
  },
};
export const Sparse: Story = {
  args: { state: 'sparse' },
  parameters: {
    docs: {
      description: {
        story:
          'A newly catalogued work with a title and no admitted cover, synopsis, facts, releases or community activity. Missing data stays missing.',
      },
    },
  },
};
export const ReleaseSectionFailure: Story = {
  args: { state: 'release-failure' },
  parameters: {
    docs: {
      description: {
        story:
          'Only the inverse release window is unavailable. Current work facts, cover, ratings and reviews remain readable, with Editions closed initially. Open Editions to see the section failure and retry. Retry reacquires the native window; it never substitutes an empty result.',
      },
    },
  },
};
export const ReviewsSectionFailure: Story = {
  args: { state: 'review-failure' },
  parameters: {
    docs: {
      description: {
        story:
          'Only reviews are unavailable. Game facts and exact releases remain usable. The installed section retry reads the same review address.',
      },
    },
  },
};
