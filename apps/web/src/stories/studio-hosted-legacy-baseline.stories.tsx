import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import { HostedLegacyBaselineVisit } from '../studio/hosted-legacy-baseline';
import type { BaselineProgress } from '../studio/hosted-legacy-baseline-contract';
import { HostedLegacyBaselineView } from '../studio/hosted-legacy-baseline-view';

type Scenario = 'PrivateProgress' | 'UnknownRetry' | 'StaleReview' | 'ReadyForPointEdit';
const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;

/** Constructed author responses illustrate interaction and layout; they are not native acceptance. */
async function prepare(scenario: Scenario, locale: Locale) {
  const owner: HostedOwnedBook = {
    viewer: { accountId: id(10), authnEpoch: 1 },
    scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
    item: {
      catalogueId: id(1),
      threadId: id(2),
      postRevisionId: id(3),
      headRevisionId: id(4),
      publicationId: id(5),
      title: 'Field notes from the northern coast',
      postVisibility: 'published',
      createdAt: '2026-11-13T09:00:00Z',
    },
  };
  const source: HistoricalReaderSource = {
    id: 'illustrative-author-session',
    revision: () => 1,
    read: () => ({
      sourceId: 'illustrative-author-session',
      generation: 1,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      state: 'signed-in',
      subject: owner.viewer.accountId,
      credentialMode: 'session',
      healthy: true,
      csrfReady: true,
    }),
    subscribe: () => () => {},
  };
  const progress: BaselineProgress = {
    catalogueId: id(1),
    sourcePublicationId: id(5),
    expectedPlacementCount: 4200,
    nextStep: scenario === 'ReadyForPointEdit' ? 'done' : 'apply',
    buildFrontier: null,
    sealFromFrontier: null,
    receivingCursor: {
      phase: 'nodes',
      occurrenceAfterOrdinal: '4200',
      nodeAfterKind: 'preorder',
      nodeAfterId: id(80),
      rootNullDone: true,
      rootAfterParentId: id(81),
    },
  };
  let calls = 0;
  const visit = new HostedLegacyBaselineVisit({
    owner,
    source,
    locale,
    csrfToken: 'illustrative-csrf',
    native: {
      readOwn: async () => ({
        ok: true,
        value: { ...owner, item: { ...owner.item, publicationId: id(8), headRevisionId: id(7) } },
      }),
      advance: async () => {
        calls += 1;
        if (scenario === 'StaleReview')
          return { ok: false, error: { kind: 'stale', message: 'Illustrative stale source.' } };
        if (scenario === 'UnknownRetry' && calls > 1)
          return { ok: false, error: { kind: 'uncertain', message: 'Illustrative unknown result.' } };
        return { ok: true, value: progress };
      },
    },
  });
  visit.confirmReview();
  await visit.continue();
  if (scenario === 'UnknownRetry') await visit.continue();
  return visit;
}

function StoryFrame({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const [mounted, setMounted] = useState<{
    locale: Locale;
    scenario: Scenario;
    visit: HostedLegacyBaselineVisit;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let visit: HostedLegacyBaselineVisit | null = null;
    void prepare(scenario, locale).then((prepared) => {
      visit = prepared;
      if (active) setMounted({ locale, scenario, visit });
      else visit.dispose();
    });
    return () => {
      active = false;
      visit?.dispose();
    };
  }, [locale, scenario]);
  return mounted?.locale === locale && mounted.scenario === scenario ? (
    <HostedLegacyBaselineView visit={mounted.visit} locale={locale} />
  ) : null;
}

const meta = {
  title: 'Pages/Studio/Legacy public baseline',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative signed-in author preparation at phone390 and desktop1280. Review all eight locales and both themes. Each Continue performs one private step; done is private readiness. Native author-to-reader, visual and promoted acceptance belong to the existing verifier lane.',
      },
    },
  },
} satisfies Meta<typeof StoryFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PrivateProgressPhone: Story = {
  args: { scenario: 'PrivateProgress' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const PrivateProgressDesktop: Story = {
  args: { scenario: 'PrivateProgress' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const UnknownRetryPhone: Story = {
  args: { scenario: 'UnknownRetry' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const UnknownRetryDesktop: Story = {
  args: { scenario: 'UnknownRetry' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const StaleReviewPhone: Story = {
  args: { scenario: 'StaleReview' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const StaleReviewDesktop: Story = {
  args: { scenario: 'StaleReview' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
export const ReadyForPointEditPhone: Story = {
  args: { scenario: 'ReadyForPointEdit' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
export const ReadyForPointEditDesktop: Story = {
  args: { scenario: 'ReadyForPointEdit' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
