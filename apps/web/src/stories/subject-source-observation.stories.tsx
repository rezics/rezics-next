import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useRef } from 'react';
import { SourceObservationReader } from '../features/catalogue/source-observation/reader';
import type {
  SourceObservationInspect,
  SourceObservationInspection,
  SourceObservationItem,
} from '../features/catalogue/source-observation/contract';
import { AppShell } from '../shell/shell';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const subjectId = '00000000-0000-8000-8000-000000000042';
const currentDigest = 'c'.repeat(64);
const selectedDigest = 'a'.repeat(64);

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
const inspection: SourceObservationInspection = {
  source: 'bangumi',
  head: { digest: current.digest, state: 'published', observation: current },
  selectedObservation: selected,
};

function ObservationStory({ mode }: { mode: 'compare' | 'withheld' | 'conflict' }) {
  const attempts = useRef(0);
  const locale = getLocale();
  const inspect = useCallback<SourceObservationInspect>(
    async (request) => {
      attempts.current += 1;
      if (mode === 'conflict' && attempts.current === 1) return { kind: 'conflict' };
      if (mode === 'withheld' && (request.history || request.cursor)) {
        return {
          kind: 'ready',
          inspection: {
            source: 'bangumi',
            head: inspection.head,
            history: request.cursor
              ? { items: [selected], nextCursor: null }
              : { items: [], nextCursor: 'opaque-example-cursor' },
          },
        };
      }
      return { kind: 'ready', inspection };
    },
    [mode],
  );
  return (
    <PatternStory
      path={`/en/subjects/${subjectId}/example/sources?provider=bangumi&digest=${selectedDigest}`}
      visitor="Signed In"
    >
      <AppShell>
        <main className="mx-auto min-w-0 max-w-4xl p-4 sm:p-8">
          <SourceObservationReader
            subjectId={subjectId}
            source="bangumi"
            digest={selectedDigest}
            locale={locale}
            sourcesHref={`/en/subjects/${subjectId}/example/sources`}
            inspect={inspect}
          />
        </main>
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Subjects/Provider observation',
  component: ObservationStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative native-format responses for the selected/current comparison, withheld history continuation and conflict retry. These stories do not establish generated-client delivery or native authorization.',
      },
    },
  },
} satisfies Meta<typeof ObservationStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentComparedWithSelected: Story = { args: { mode: 'compare' } };
export const WithheldHistoryContinues: Story = { args: { mode: 'withheld' } };
export const ChangedSourceRetry: Story = { args: { mode: 'conflict' } };
