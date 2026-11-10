import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { expect, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { inspectSourceObservation } from '../features/catalogue/source-observation/contract';
import type {
  SourceObservationInspect,
  SourceObservationItem,
  SourceObservationOperation,
  SourceObservationOutcome,
  SourceObservationRequest,
  SourceObservationProvider,
} from '../features/catalogue/source-observation/contract';
import { SubjectSourcesPage } from '../features/catalogue/subject-sources-page';
import type { SourcesPageData } from '../features/catalogue/subject-sources';
import { pageText } from '../features/pages/shared';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

const subjectId = '00000000-0000-8000-8000-000000000042';
const currentDigest = 'c'.repeat(64);
const selectedDigest = 'a'.repeat(64);
const historyDigest = 'b'.repeat(64);
const clearDigest = 'e'.repeat(64);

function item(digest: string, nativeOrder: string, asOf: string, mean: number): SourceObservationItem {
  return {
    digest,
    payloadVersion: 1,
    sourceAlias: 'bangumi',
    sourceRecordId: '248001',
    asOf,
    nativeOrder,
    legacy: false,
    provenance: { kind: 'unversioned', digest },
    payload: {
      sourceAlias: 'bangumi',
      sourceRecordId: '248001',
      scale: { min: 0, max: 10 },
      mean,
      count: 120,
      asOf,
      licence: 'CC-BY-4.0',
      attribution: 'Illustrative Bangumi source data',
      figures: {
        schemaVersion: 1,
        distribution: {
          unit: 'ratings',
          completeness: 'partial',
          bins: Array.from({ length: 10 }, (_, index) => ({ score: index + 1, count: index + 1 })),
        },
      },
    },
  };
}

const selected = item(selectedDigest, '17', '2026-10-20', 7.2);
const current = item(currentDigest, '22', '2026-11-01', 7.4);
const history = item(historyDigest, '16', '2026-10-19', 7.1);
const cleared: SourceObservationItem = {
  digest: clearDigest,
  payloadVersion: 1,
  sourceAlias: 'vndb',
  sourceRecordId: 'cleared-record',
  asOf: '2026-11-02',
  nativeOrder: '23',
  legacy: false,
  provenance: { kind: 'unversioned', digest: clearDigest },
  payload: { sourceAlias: 'vndb', sourceRecordId: 'cleared-record', count: 0, asOf: '2026-11-02' },
};

const sourcesPage: SourcesPageData = {
  id: subjectId,
  title: pageText('Example Subject', 'en'),
  typeLabel: pageText('Subject', 'en'),
  href: `/en/subjects/${subjectId}/example`,
  sourcesHref: `/en/subjects/${subjectId}/example/sources?realm=realm-a`,
  fields: [],
  related: {},
  sources: { credit: null, records: [], urls: [], identifiers: [] },
};

type Mode = 'compare' | 'sparse' | 'cleared' | 'missing' | 'retry' | 'conflict' | 'replacement';
type Selection = { source: SourceObservationProvider; digest: string };

function response(
  request: SourceObservationRequest,
  head: SourceObservationItem | null,
  selectedItem: SourceObservationItem | undefined,
  sparse: boolean,
) {
  const digest = head?.digest ?? null;
  return {
    source: request.source,
    head: {
      digest,
      state: head === null ? 'empty' : head.payload.count === 0 ? 'cleared' : 'published',
      observation: head,
    },
    resolution: { put: { expectedObservation: digest }, clear: { expectedObservation: digest } },
    ...(request.digest ? { selectedObservation: selectedItem } : {}),
    ...(request.history || request.cursor
      ? {
          history: {
            items: request.source === 'vndb' ? [] : request.cursor || !sparse ? [history] : [],
            nextCursor: request.source === 'vndb' || request.cursor || !sparse ? null : 'opaque-native-cursor',
          },
        }
      : {}),
  };
}

function ObservationStory({ mode }: { mode: Mode }) {
  const attempts = useRef(0);
  const pending = useRef<((outcome: SourceObservationOutcome) => void) | null>(null);
  const [selection, setSelection] = useState<Selection>(() =>
    mode === 'cleared' ? { source: 'vndb', digest: clearDigest } : { source: 'bangumi', digest: selectedDigest },
  );
  const locale = getLocale();
  const inspect = useCallback<SourceObservationInspect>(
    async (request) => {
      if (mode === 'replacement' && request.source === 'bangumi')
        return new Promise<SourceObservationOutcome>((resolve) => {
          pending.current = resolve;
        });
      const operation: SourceObservationOperation = async (input) => {
        if (mode === 'missing' && input.digest) return { status: 404 };
        if (mode === 'conflict' && attempts.current++ === 0) return { status: 409 };
        if (mode === 'retry' && attempts.current++ === 0) return { status: 503 };
        const head = input.source === 'vndb' ? cleared : current;
        const selectedItem = input.digest === clearDigest ? cleared : selected;
        return { status: 200, data: response(input, head, selectedItem, mode === 'sparse') };
      };
      return inspectSourceObservation(operation, request);
    },
    [mode],
  );
  useEffect(() => {
    if (selection.source === 'vndb' && pending.current) {
      pending.current({
        kind: 'ready',
        inspection: {
          source: 'bangumi',
          head: { digest: current.digest, state: 'published', observation: current },
        },
      });
      pending.current = null;
    }
  }, [selection.source]);
  const observation = {
    ...selection,
    visitKey: JSON.stringify([subjectId, selection.source, selection.digest, mode]),
    inspect,
  };
  const path = `/en/subjects/${subjectId}/example/sources?realm=realm-a&provider=${selection.source}&digest=${selection.digest}`;

  return (
    <PatternStory path={path} visitor="Signed In">
      <AppShell>
        <main className="mx-auto min-w-0 max-w-4xl p-4 sm:p-8">
          {mode === 'replacement' && selection.source === 'bangumi' && (
            <Button className="mb-4 min-h-11" onClick={() => setSelection({ source: 'vndb', digest: clearDigest })}>
              Replace provider while the read is pending
            </Button>
          )}
          <SubjectSourcesPage result={{ kind: 'ready', page: sourcesPage }} locale={locale} observation={observation} />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Subjects/Provider observation',
  id: 'pages-subjects-provider-observation',
  component: ObservationStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Native-shaped response examples pass through the Web admission adapter and the existing Subject Sources panel. They are illustrative and do not establish generated-client delivery, importer authorization, or native acceptance.',
      },
    },
  },
} satisfies Meta<typeof ObservationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentComparedWithSelected: Story = {
  args: { mode: 'compare' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const back = await canvas.findByRole('link', { name: m.source_observation_back() });
    expect(back.getAttribute('href')).toBe(
      `/en/subjects/${subjectId}/example/sources?realm=realm-a#subject-sources-heading`,
    );
    expect(canvas.getByRole('heading', { name: m.subject_sources() }).getAttribute('id')).toBe(
      'subject-sources-heading',
    );
  },
};
export const SparseHistoryContinues: Story = { args: { mode: 'sparse' } };
export const ClearedZero: Story = { args: { mode: 'cleared' } };
export const ExactObservationConcealed: Story = { args: { mode: 'missing' } };
export const UnavailableReadCanRetry: Story = { args: { mode: 'retry' } };
export const ChangedSourceCanRetry: Story = { args: { mode: 'conflict' } };
export const PendingReadRetiredOnProviderReplacement: Story = { args: { mode: 'replacement' } };
