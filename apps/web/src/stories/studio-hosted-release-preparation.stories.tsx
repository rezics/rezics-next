import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import { HostedReleasePreparationVisit } from '../studio/hosted-release-preparation';
import type { ReleaseProgress } from '../studio/hosted-release-preparation-contract';
import { releaseCopy } from '../studio/hosted-release-preparation-copy';
import { HostedReleasePreparationView } from '../studio/hosted-release-preparation-view';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
type Scenario = 'interrupted' | 'expired';

/** Mirrors the whole-source replies in Kernel's hosted-publication-preparation-http.test.ts, without activation data. */
function reply(stageId: string, step: number): ReleaseProgress {
  return {
    catalogueId: id(1),
    stageId,
    stage: {
      locator: { catalogueId: id(1), stageId },
      state: step === 0 ? 'building' : step === 1 ? 'ready' : 'sealed',
      mode: 'whole',
      inputVersion: '0',
      inputCount: '0',
      settledInputCount: '0',
      candidateCount: step ? '4' : '0',
      sourceFrontier: step ? '3' : '-1',
      sourceExhausted: step > 0,
      closureFrontier: '-1',
      closureCheckedCount: '0',
      closureMissingCount: '0',
      failure: null,
    },
    candidate:
      step < 2
        ? null
        : {
            candidateId: id(30),
            generationId: id(31),
            afterSourceOrder: step > 2 ? '3' : null,
            placementCount: step > 2 ? '4' : '0',
            rootCount: step > 2 ? '2' : '0',
            chapterCount: step > 2 ? '2' : '0',
            coverageComplete: step > 2,
            sealed: step > 3,
          },
    candidateReady: step > 3,
  };
}

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
    id: 'story-author',
    revision: () => 1,
    subscribe: () => () => {},
    read: () => ({
      sourceId: 'story-author',
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
  const receipts = new Map<string, ReleaseProgress>();
  let step = 0;
  let interrupted = false;
  const visit = new HostedReleasePreparationVisit({
    owner,
    source,
    locale,
    csrfToken: 'story-csrf',
    stageId: scenario === 'expired' ? id(20) : null,
    native: {
      readOwn: async () => ({ ok: true, value: owner }),
      command: async (input) => {
        const retained = receipts.get(input.idempotencyKey);
        if (retained) return { ok: true, value: retained };
        if (input.kind === 'progress' && input.stageId === id(20))
          return {
            ok: true,
            value: { ...reply(input.stageId, 0), stage: { ...reply(input.stageId, 0).stage, state: 'expired' } },
          };
        if (input.kind === 'start') step = 0;
        if (input.kind === 'advance') step += 1;
        if (input.kind === 'seal') step = 4;
        let value = reply(input.stageId, step);
        if (input.kind === 'cancel')
          value = { ...value, stage: { ...value.stage, state: 'cancelled' }, candidate: null, candidateReady: false };
        receipts.set(input.idempotencyKey, value);
        if (input.kind === 'advance' && !interrupted) {
          interrupted = true;
          return { ok: false, error: { kind: 'uncertain', message: 'Committed reply was interrupted.' } };
        }
        return { ok: true, value };
      },
    },
  });
  if (scenario === 'expired') await visit.readProgress();
  else {
    visit.confirmReview();
    await visit.start();
    await visit.resume();
  }
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
  title: 'Pages/Studio/Private whole-Book release',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Native preparation response shapes, including a lost committed reply and native expiry. Preparation and sealing leave the existing release current. No activation or public navigation is simulated.',
      },
    },
  },
} satisfies Meta<typeof StoryFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InterruptedThenSealedDesktop: Story = {
  args: { scenario: 'interrupted' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = releaseCopy[getLocale()];
    await userEvent.click(await canvas.findByRole('button', { name: copy.retry }));
    await userEvent.click(await canvas.findByRole('button', { name: copy.resume }));
    await userEvent.click(await canvas.findByRole('button', { name: copy.seal }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(copy.prepared);
    await expect(canvas.getByText(id(5), { exact: true })).toBeVisible();
  },
};
export const ExpiredStagePhone: Story = {
  args: { scenario: 'expired' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const copy = releaseCopy[getLocale()];
    await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.expired);
    await userEvent.click(canvas.getByRole('button', { name: copy.refresh }));
    await expect(await canvas.findByRole('button', { name: copy.confirm })).toBeEnabled();
  },
};
