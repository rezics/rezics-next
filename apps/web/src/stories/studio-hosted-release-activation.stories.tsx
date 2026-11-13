import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { getLocale, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { HostedOwnedBook } from '../studio/hosted-contract';
import type {
  ActivationProgress,
  HostedReleaseActivationOperations,
} from '../studio/hosted-release-activation-contract';
import type { ReleaseProgress } from '../studio/hosted-release-preparation-contract';
import { activationCopy } from '../studio/hosted-release-activation-copy';
import { createHostedReleaseActivationTransport } from '../studio/hosted-release-activation-native';
import { HostedReleasePreparationVisit } from '../studio/hosted-release-preparation';
import { HostedReleasePreparationView } from '../studio/hosted-release-preparation-view';

const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
type Scenario = 'checking' | 'restart' | 'lost-reply';
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
const prepared: ReleaseProgress = {
  catalogueId: id(1),
  stageId: id(20),
  candidateReady: true,
  stage: {
    locator: { catalogueId: id(1), stageId: id(20) },
    state: 'sealed',
    mode: 'whole',
    sourceRevisionId: id(4),
    expectedHeadRevisionId: id(4),
    expectedPublicationId: id(5),
    inputVersion: '0',
    inputCount: '0',
    settledInputCount: '0',
    candidateCount: '22',
    sourceFrontier: '21',
    sourceExhausted: true,
    closureFrontier: '-1',
    closureCheckedCount: '0',
    closureMissingCount: '0',
    failure: null,
  },
  candidate: {
    candidateId: id(30),
    generationId: id(31),
    afterSourceOrder: '21',
    placementCount: '22',
    rootCount: '1',
    chapterCount: '21',
    coverageComplete: true,
    sealed: true,
  },
};

/** Illustrative native-shaped operation replies. These are never imported by the ordinary Studio adapter. */
async function prepare(scenario: Scenario, locale: Locale) {
  const source: HistoricalReaderSource = {
    id: 'illustrative-author',
    revision: () => 1,
    subscribe: () => () => {},
    read: () => ({
      sourceId: 'illustrative-author',
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
  let current = owner;
  let step = 0;
  let passId = id(40);
  let restarted = false;
  let lost = false;
  const receipts = new Map<string, ActivationProgress>();
  const progress = (state: ActivationProgress['state']): ActivationProgress => ({
    catalogueId: id(1),
    stageId: id(20),
    state,
    passId,
    checkedTargetCount: step === 0 ? '0' : step === 1 ? '20' : '22',
    totalTargetCount: '22',
    candidateGenerationId: id(31),
    publicationId: state === 'activated' ? id(60) : null,
    restartRequired: state === 'restart',
  });
  const command =
    (kind: 'start' | 'advance' | 'activate'): HostedReleaseActivationOperations['startHostedPublicationActivation'] =>
    async (input) => {
      const replay = receipts.get(input.idempotencyKey);
      if (replay) return { ok: true, value: replay };
      if (kind === 'advance') step += 1;
      let value = progress(step >= 2 ? 'ready' : 'checking');
      if (kind === 'activate') {
        value = progress(scenario === 'restart' && !restarted ? 'restart' : 'activated');
        if (value.state === 'activated') current = { ...owner, item: { ...owner.item, publicationId: id(60) } };
      }
      if (kind === 'advance' && scenario === 'restart' && step === 3 && !restarted) {
        restarted = true;
        passId = id(41);
        step = 1;
        value = progress('checking');
      }
      receipts.set(input.idempotencyKey, value);
      if (scenario === 'lost-reply' && value.state === 'activated' && !lost) {
        lost = true;
        return { ok: false, error: { kind: 'uncertain', message: 'Illustrative lost committed reply.' } };
      }
      return { ok: true, value };
    };
  const native = createHostedReleaseActivationTransport({
    startHostedPublicationActivation: command('start'),
    advanceHostedPublicationActivationAuthority: command('advance'),
    activateHostedPublicationCandidate: command('activate'),
    readOwn: async () => ({ ok: true, value: current }),
    readMetadata: async (input) => ({
      ok: true,
      value: {
        catalogueId: input.catalogueId,
        revisionId: input.revisionId!,
        kind: 'publication',
        sourceRevisionId: id(4),
      },
    }),
    admitPublic: async () => true,
  });
  const visit = new HostedReleasePreparationVisit({
    owner,
    source,
    locale,
    csrfToken: 'illustrative-csrf',
    stageId: id(20),
    native: { readOwn: async () => ({ ok: true, value: owner }), command: async () => ({ ok: true, value: prepared }) },
  });
  await visit.readProgress();
  return { visit, binding: { source, native, csrfToken: 'illustrative-csrf' } };
}
function StoryFrame({ scenario }: { scenario: Scenario }) {
  const locale = getLocale();
  const [mounted, setMounted] = useState<{
    locale: Locale;
    scenario: Scenario;
    prepared: Awaited<ReturnType<typeof prepare>>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let owned: Awaited<ReturnType<typeof prepare>> | null = null;
    void prepare(scenario, locale).then((prepared) => {
      owned = prepared;
      if (active) setMounted({ locale, scenario, prepared });
      else prepared.visit.dispose();
    });
    return () => {
      active = false;
      owned?.visit.dispose();
    };
  }, [locale, scenario]);
  return (
    <>
      <aside className="mx-auto max-w-4xl px-4 pt-4 text-sm" role="note">
        Illustrative fixture: native-shaped operations, not mounted transport or publication acceptance.
      </aside>
      {mounted?.locale === locale && mounted.scenario === scenario ? (
        <HostedReleasePreparationView
          visit={mounted.prepared.visit}
          locale={locale}
          activation={mounted.prepared.binding}
        />
      ) : null}
    </>
  );
}
const meta = {
  title: 'Pages/Studio/Prepared Book activation (illustrative)',
  component: StoryFrame,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative injectable native operations through the actual preparation/activation consumer. These stories prove no mounted transport, native root swap or promotion acceptance. Eight locale controls retain the exact private candidate across explicit commands.',
      },
    },
  },
} satisfies Meta<typeof StoryFrame>;
export default meta;
type Story = StoryObj<typeof meta>;
async function checkToReady(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const copy = activationCopy[getLocale()];
  await userEvent.click(await canvas.findByRole('button', { name: copy.start }));
  await userEvent.click(await canvas.findByRole('button', { name: copy.next }));
  await expect(canvas.queryByRole('button', { name: copy.activate })).toBeNull();
  await userEvent.click(await canvas.findByRole('button', { name: copy.next }));
  await expect(await canvas.findByRole('button', { name: copy.activate })).toBeEnabled();
  return { canvas, copy };
}
export const AuthorDesktopCheckingThenExplicitActivation: Story = {
  args: { scenario: 'checking' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { canvas, copy } = await checkToReady(canvasElement);
    await expect(canvas.getByText(id(5), { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: copy.activate }));
    await expect(await canvas.findByText(copy.verified)).toBeVisible();
    await expect(
      await canvas.findByRole('link', {
        name: new RegExp(m.studio_hosted_view_published_book({}, { locale: getLocale() })),
      }),
    ).toHaveAttribute('target', '_blank');
  },
};
export const NarrowAuthorityRestartRetainsCandidate: Story = {
  args: { scenario: 'restart' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { canvas, copy } = await checkToReady(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: copy.activate }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.restart);
    await expect(canvas.getByText(id(31), { exact: true })).toBeVisible();
    await expect(canvas.getByText(id(5), { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: copy.restartAction }));
    await expect(await canvas.findByText(id(41), { exact: true })).toBeVisible();
    await expect(canvas.getByText(id(31), { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: copy.pause }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(copy.paused);
  },
};
export const LostReplySameIntentRecovery: Story = {
  args: { scenario: 'lost-reply' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { canvas, copy } = await checkToReady(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: copy.activate }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.unknown);
    await userEvent.click(canvas.getByRole('button', { name: copy.read }));
    await expect(await canvas.findByText(copy.observed)).toBeVisible();
    await expect(canvas.getByRole('button', { name: copy.retry })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: copy.retry }));
    await expect(await canvas.findByText(copy.verified)).toBeVisible();
  },
};
