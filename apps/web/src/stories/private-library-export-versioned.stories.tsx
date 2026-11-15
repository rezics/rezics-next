import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fn } from 'storybook/test';
import {
  EXPORT_FORMAT,
  EXPORT_PRIVACY,
  EXPORT_COMPLETENESS,
  EXPORT_SECTIONS,
  EXPORT_COVERAGE,
  type ExportSectionTotals,
  type ExportManifest,
} from '../library/private-export/contract';
import type { ExportJourneySnapshot, ExportStage } from '../library/private-export/controller';
import { emptyExportCost } from '../library/private-export/cost';
import { ExportVisitView } from '../library/private-export/page';

const meta = {
  title: 'Library/Private Data/Private Export Capture States',
  id: 'pages-library-private-export-capture-states',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative contract-shaped states in the actual routed export presentation. Actions are logged; these fixtures do not perform capture, delivery or restoration and are not native acceptance evidence. Opening is still; choose locale and viewport manually.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onAction = fn();
const onLeave = fn();

function RoutedState({ snapshot }: { snapshot: ExportJourneySnapshot }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({
        component: () => <ExportVisitView snapshot={snapshot} onAction={onAction} onLeave={onLeave} />,
      }),
      history: createMemoryHistory({ initialEntries: ['/en/library/export'] }),
    }),
  );
  return <RouterProvider router={router} />;
}

const zeroSectionTotals = Object.fromEntries(
  EXPORT_SECTIONS.map((section) => [section, { rows: 0, recordBytes: 0 }]),
) as ExportSectionTotals;
const manifest: ExportManifest = {
  format: EXPORT_FORMAT,
  version: 1,
  coverage: EXPORT_COVERAGE,
  exportId: '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa',
  capturedAt: '2026-11-04T12:00:00.000Z',
  expiresAt: '2026-11-04T12:15:00.000Z',
  privacy: EXPORT_PRIVACY,
  completeness: EXPORT_COMPLETENESS,
  sections: [...EXPORT_SECTIONS],
  omissions: {
    trash: 'excluded',
    providerIdentifiers: 'stored evidence only',
    personalImportEvidence: 'retained rows only',
    commerce: 'excluded',
    publication: 'excluded',
    reimport: 'reviewed recovery of supported native facts only; unsupported evidence never authorizes execution',
  },
  fullExport: false,
  rows: 9,
  recordBytes: 1932,
  sectionTotals: {
    ...zeroSectionTotals,
    entries: { rows: 3, recordBytes: 480 },
    journals: { rows: 2, recordBytes: 480 },
    vndbUploads: { rows: 1, recordBytes: 220 },
    vndbEvidence: { rows: 1, recordBytes: 310 },
    anilistUploads: { rows: 1, recordBytes: 180 },
    anilistEvidence: { rows: 1, recordBytes: 262 },
  },
};

function snapshot(
  stage: ExportStage,
  value: ExportManifest = manifest,
  extra: Partial<ExportJourneySnapshot> = {},
): ExportJourneySnapshot {
  const complete = stage === 'ready' || stage === 'empty' || stage === 'save-failed';
  const captured = stage !== 'coverage';
  return {
    stage,
    busy: stage === 'preparing' || stage === 'capturing' || stage === 'cancelling',
    notice: null,
    exportId: captured ? value.exportId : null,
    requestKey: 'illustrative-original-command',
    capturedAt: captured ? value.capturedAt : null,
    expiresAt: captured ? value.expiresAt : null,
    completeness: captured ? value.completeness : null,
    fullExport: false,
    sections: captured ? [...value.sections] : [],
    omissions: captured ? value.omissions : {},
    pages: complete ? 8 : 0,
    records: complete ? value.rows : 0,
    manifest: complete ? value : null,
    hasArtifact: complete,
    previousDisposition: null,
    cost: emptyExportCost(),
    ...extra,
  };
}

export const Coverage: Story = {
  name: 'Canonical v1 coverage (illustrative)',
  render: () => <RoutedState snapshot={snapshot('coverage')} />,
};

export const Capturing: Story = {
  name: 'Canonical v1 capturing (illustrative)',
  render: () => <RoutedState snapshot={snapshot('capturing', manifest, { records: 7, pages: 5 })} />,
};

export const Ready: Story = {
  name: 'Canonical v1 ready with provider evidence (illustrative)',
  render: () => <RoutedState snapshot={snapshot('ready')} />,
};

export const SaveFailure: Story = {
  name: 'Canonical v1 save failure (illustrative)',
  render: () => <RoutedState snapshot={snapshot('save-failed')} />,
};

export const BytesLostReplay: Story = {
  name: 'Canonical v1 bytes lost, original replay (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('ready', manifest, {
        notice: { kind: 'bytes-lost' },
        hasArtifact: false,
        records: 0,
      })}
    />
  ),
};

export const UnknownCancellation: Story = {
  name: 'Cancellation outcome unknown (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('cancelling', manifest, {
        busy: false,
        pages: 5,
        notice: { kind: 'unknown', command: { kind: 'cancel', exportId: manifest.exportId } },
      })}
    />
  ),
};

export const Empty: Story = {
  name: 'Canonical v1 empty section totals (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('empty', { ...manifest, rows: 0, recordBytes: 0, sectionTotals: zeroSectionTotals })}
    />
  ),
};
