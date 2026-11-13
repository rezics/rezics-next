import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { HostedReleasePreparationVisit } from '../studio/hosted-release-preparation';
import type { ReleaseProgress } from '../studio/hosted-release-preparation-contract';
import { releaseCopy } from '../studio/hosted-release-preparation-copy';
import { releaseSelectionCopy } from '../studio/hosted-release-selection-copy';
import { HostedReleasePreparationView } from '../studio/hosted-release-preparation-view';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
type Scenario = 'two-pages' | 'lost-batch' | 'resume';
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

/** Native collecting/batch/freeze shapes; selection stays Book-owned and never changes the release pointer. */
async function prepare(scenario: Scenario, locale: Locale) {
  const source: HistoricalReaderSource = {
    id: 'selection-author',
    revision: () => 1,
    subscribe: () => () => {},
    read: () => ({
      sourceId: 'selection-author',
      generation: 1,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      state: 'signed-in',
      subject: owner.viewer.accountId,
      credentialMode: 'session',
      healthy: true,
      csrfReady: true,
    }),
  };
  let inputCount = scenario === 'resume' ? 1 : 0;
  let inputVersion = scenario === 'resume' ? 1 : 0;
  let stageState: ReleaseProgress['stage']['state'] = 'collecting';
  let lost = false;
  const receipts = new Map<string, ReleaseProgress>();
  const progress = (stageId: string): ReleaseProgress => ({
    catalogueId: id(1),
    stageId,
    stage: {
      locator: { catalogueId: id(1), stageId },
      mode: 'selection',
      state: stageState,
      sourceRevisionId: id(4),
      expectedHeadRevisionId: id(4),
      expectedPublicationId: id(5),
      inputVersion: String(inputVersion),
      inputCount: String(inputCount),
      settledInputCount: '0',
      candidateCount: '0',
      sourceFrontier: '-1',
      sourceExhausted: false,
      closureFrontier: '-1',
      closureCheckedCount: '0',
      closureMissingCount: '0',
      failure: null,
    },
    candidate: null,
    candidateReady: false,
  });
  const visit = new HostedReleasePreparationVisit({
    owner,
    source,
    locale,
    csrfToken: 'story-csrf',
    selectionNative: {
      readOutlineWindow: async ({ revision, cursor }) => ({
        ok: true,
        value: {
          ...revision,
          items:
            cursor === null
              ? [
                  {
                    occurrenceId: id(60),
                    parentId: null,
                    position: 0,
                    kind: 'part',
                    availability: 'available',
                    title: 'Northern coast',
                    target: null,
                  },
                ]
              : [
                  {
                    occurrenceId: id(61),
                    parentId: id(60),
                    position: 0,
                    kind: 'chapter',
                    availability: 'available',
                    title: 'Tide pools',
                    target: { threadId: id(70), postId: id(71), revisionId: id(72), sha256: 'a'.repeat(64) },
                  },
                ],
          nextCursor: cursor === null ? 'exact-second-page' : null,
        },
      }),
    },
    native: {
      readOwn: async () => ({ ok: true, value: owner }),
      command: async (input) => {
        const retained = receipts.get(input.idempotencyKey);
        if (retained) return { ok: true, value: retained };
        if (input.kind === 'start') {
          inputCount = 0;
          inputVersion = 0;
          stageState = 'collecting';
        }
        if (input.kind === 'freeze') stageState = 'building';
        if (input.kind === 'cancel') stageState = 'cancelled';
        let value: ReleaseProgress;
        if (input.kind === 'append') {
          const firstInputPosition = String(inputCount);
          inputCount += input.body.occurrenceIds.length;
          inputVersion += 1;
          value = {
            ...progress(input.stageId),
            batch: {
              replayed: false,
              inputVersion: String(inputVersion),
              firstInputPosition,
              itemCount: input.body.occurrenceIds.length,
            },
          };
        } else value = progress(input.stageId);
        receipts.set(input.idempotencyKey, value);
        if (input.kind === 'append' && scenario === 'lost-batch' && !lost) {
          lost = true;
          return { ok: false, error: { kind: 'uncertain', message: 'Lost committed page response.' } };
        }
        return { ok: true, value };
      },
    },
    stageId: scenario === 'resume' ? id(40) : null,
  });
  if (scenario === 'lost-batch') {
    visit.confirmReview();
    await visit.start('selection');
    visit.choosePlacement(id(60));
    await visit.appendSelection();
  }
  if (scenario === 'resume') await visit.readProgress();
  return visit;
}

function StoryFrame({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const [mounted, setMounted] = useState<{
    visit: HostedReleasePreparationVisit;
    locale: Locale;
    scenario: Scenario;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let visit: HostedReleasePreparationVisit | null = null;
    void prepare(scenario, locale).then((prepared) => {
      visit = prepared;
      if (active) setMounted({ visit, locale, scenario });
      else visit.dispose();
    });
    return () => {
      active = false;
      visit?.dispose();
    };
  }, [locale, scenario]);
  return mounted?.locale === locale && mounted.scenario === scenario ? (
    <HostedReleasePreparationView visit={mounted.visit} locale={locale} />
  ) : null;
}

const meta = {
  title: 'Pages/Studio/Private selected Book release',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'An admitted author selects explicit placements on two exact draft pages, acknowledges native counts and freezes input. Resume recovers the same stage and exact draft after reload; the narrow case retries the exact lost batch. The published release stays current.',
      },
    },
  },
} satisfies Meta<typeof StoryFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TwoPagesThenFreezeDesktop: Story = {
  args: { scenario: 'two-pages' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = releaseCopy[getLocale()];
    const selection = releaseSelectionCopy[getLocale()];
    await userEvent.click(await canvas.findByRole('button', { name: copy.confirm }));
    await userEvent.click(await canvas.findByRole('button', { name: selection.start }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: /Northern coast/ }));
    await userEvent.click(canvas.getByRole('button', { name: selection.add }));
    await userEvent.click(await canvas.findByRole('button', { name: selection.next }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: /Tide pools/ }));
    await userEvent.click(canvas.getByRole('button', { name: selection.add }));
    await userEvent.click(await canvas.findByRole('button', { name: selection.freeze }));
    await expect(await canvas.findByText(selection.frozen)).toBeVisible();
    await expect(canvas.getByText(id(5), { exact: true })).toBeVisible();
    await expect(canvas.queryByRole('checkbox')).toBeNull();
  },
};
export const LostBatchThenFreezePhone: Story = {
  args: { scenario: 'lost-batch' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = releaseCopy[getLocale()];
    const selection = releaseSelectionCopy[getLocale()];
    await expect(await canvas.findByText(selection.pending)).toBeVisible();
    await expect(canvas.getByRole('button', { name: selection.freeze })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: copy.retry }));
    await userEvent.click(await canvas.findByRole('button', { name: selection.next }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: /Tide pools/ }));
    await userEvent.click(canvas.getByRole('button', { name: selection.add }));
    await userEvent.click(await canvas.findByRole('button', { name: selection.freeze }));
    await expect(await canvas.findByText(selection.frozen)).toBeVisible();
    await expect(canvas.getByText(id(5), { exact: true })).toBeVisible();
  },
};

export const ResumeSameDraftAfterReload: Story = {
  args: { scenario: 'resume' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const selection = releaseSelectionCopy[getLocale()];
    const section = await canvas.findByRole('region', { name: selection.heading });
    await expect(within(section).getByText('1', { exact: true })).toBeVisible();
    await expect(canvas.getByText(selection.resumed)).toBeVisible();
    await userEvent.click(await within(section).findByRole('button', { name: selection.next }));
    await userEvent.click(await within(section).findByRole('checkbox', { name: /Tide pools/ }));
    await userEvent.click(within(section).getByRole('button', { name: selection.add }));
    await userEvent.click(await within(section).findByRole('button', { name: selection.freeze }));
    await expect(within(section).getByText(selection.frozen)).toBeVisible();
    await expect(within(section).getByText('2', { exact: true })).toBeVisible();
  },
};
