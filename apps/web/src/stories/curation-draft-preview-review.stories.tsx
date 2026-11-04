import {
  planReads,
  platformRegistry,
  PROFILE_FORMAT,
  profileDigest,
  resolveView,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import recorded from '../kernel/recorded/subject.json';
import type { SubjectPageData } from '../features/pages/subject';
import type { CurationAdmissionLease } from '../features/pages/curation-reader-admission';
import type { DraftPreviewInput, DraftPreviewRead, DraftPreviewResult } from '../features/pages/draft-preview';
import { DraftPreviewPanel } from '../features/pages/draft-preview-view';

const sampleDocument: CompositionDocument = {
  root: { props: {} },
  content: [
    { type: 'SubjectHeader', props: { id: 'header' } },
    { type: 'Heading', props: { id: 'heading', level: 2, text: { en: 'A captured reading view' } } },
  ],
};
const profile: PresentationProfile = {
  format: PROFILE_FORMAT,
  generic: { views: { overview: sampleDocument, details: sampleDocument } },
  bases: [],
  types: [],
  routes: [],
};
const lease = {
  reader: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10',
  isCurrent: () => true,
  onRetire: () => () => {},
} as unknown as CurationAdmissionLease;

function pageFor(input: DraftPreviewInput): SubjectPageData {
  const digest = profileDigest(input.profile);
  const selectedView = 'view' in input.target ? (input.target.view ?? 'overview') : 'overview';
  const witness = 'route' in input.target ? { route: input.target.route } : {};
  const document = resolveView(input.profile, witness, selectedView)?.document ?? sampleDocument;
  const reads = Object.fromEntries(
    Object.keys(planReads(platformRegistry, document, { subject: recorded.subject.id }).reads).map((key) => [
      key,
      { status: 200, body: recorded },
    ]),
  );
  return {
    profile: digest,
    subject: 'route' in input.target ? null : recorded.subject.id,
    ...('account' in input.target ? { account: { handle: input.target.account } } : {}),
    template: 'route' in input.target ? { scope: 'route', key: input.target.route } : { scope: 'generic', key: null },
    document,
    reads,
    draft: { digest, target: input.target, advice: 'allowed' },
  } as unknown as SubjectPageData;
}

function success(input: DraftPreviewInput): DraftPreviewResult {
  return {
    ok: true,
    digest: profileDigest(input.profile),
    target: input.target,
    locale: input.locale,
    page: pageFor(input),
  };
}

function PanelFrame({ read }: { read: DraftPreviewRead }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto max-w-5xl p-4 sm:p-8">
        <DraftPreviewPanel profile={profile} locale="en" lease={lease} read={read} />
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Curation/Draft Preview Review',
  component: DraftPreviewPanel,
  parameters: {
    layout: 'fullscreen',
    viewport: { defaultViewport: 'responsive' },
  },
  render: ({ read }) => <PanelFrame read={read} />,
} satisfies Meta<typeof DraftPreviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CapturedSubject: Story = {
  args: {
    profile,
    locale: 'en',
    lease,
    read: async (input) => success(input),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Subject ID' }), recorded.subject.id);
    await userEvent.click(canvas.getByRole('button', { name: 'Capture current candidate' }));
    await waitFor(() => expect(canvas.getByRole('heading', { name: 'A captured reading view' })).toBeVisible());
  },
};

export const ChangedAccountAndRouteCandidate: Story = {
  args: {
    profile,
    locale: 'en',
    lease,
    read: async (input) => success(input),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Target' }), 'account');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Account handle' }), 'public-reader');
    await userEvent.click(canvas.getByRole('button', { name: 'Capture current candidate' }));
    await waitFor(() => expect(canvas.getByRole('heading', { name: 'A captured reading view' })).toBeVisible());
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Target' }), 'route');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Route' }), '/');
    await expect(canvas.getByText(/Current input differs from this captured preview/)).toBeVisible();
  },
};

const unavailableInputs: DraftPreviewInput[] = [];
const unavailableReader: DraftPreviewRead = async (input) => {
  unavailableInputs.push(structuredClone(input));
  return { ok: false, reason: 'unavailable' };
};

export const UnavailableRetryVersusRecapture: Story = {
  args: {
    profile,
    locale: 'en',
    lease,
    read: unavailableReader,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    unavailableInputs.length = 0;
    const panel = canvas.getByRole('region', { name: 'Captured draft preview' });
    const subject = canvas.getByRole('textbox', { name: 'Subject ID' });
    await userEvent.type(subject, recorded.subject.id);
    await userEvent.click(canvas.getByRole('button', { name: 'Capture current candidate' }));
    await waitFor(() =>
      expect(canvas.getByText(/preview service or one of its required reads is unavailable/i)).toBeVisible(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Target' }), 'account');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Account handle' }), 'current-reader');
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry captured target' }));
    await waitFor(() => expect(unavailableInputs).toHaveLength(2));
    await expect(unavailableInputs[1]!.target).toEqual({ subject: recorded.subject.id, view: 'overview' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Capture current candidate' }));
    await waitFor(() => expect(unavailableInputs).toHaveLength(3));
    await expect(unavailableInputs[2]!.target).toEqual({ account: 'current-reader', view: 'overview' });
    await expect(within(panel).getByRole('button', { name: 'Retry captured target' })).toBeVisible();
    await expect(within(panel).getByRole('button', { name: 'Capture current candidate' })).toBeVisible();
  },
};
