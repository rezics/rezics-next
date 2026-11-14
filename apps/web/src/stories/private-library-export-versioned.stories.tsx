import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { fn } from 'storybook/test';
import {
  EXPORT_FORMAT,
  EXPORT_PRIVACY,
  EXPORT_COMPLETENESS,
  EXPORT_SECTIONS_V1,
  EXPORT_SECTIONS_V2,
  EXPORT_SECTIONS_V3,
  EXPORT_SECTIONS_V4,
  EXPORT_V2_COVERAGE,
  EXPORT_V3_COVERAGE,
  EXPORT_V4_COVERAGE,
  type ExportSectionTotals,
  type ExportManifest,
  type ExportManifestV1,
  type ExportManifestV2,
  type ExportManifestV3,
  type ExportManifestV4,
} from '../library/private-export/contract';
import type { ExportJourneySnapshot, ExportStage } from '../library/private-export/controller';
import { emptyExportCost } from '../library/private-export/cost';
import { ExportVisitView } from '../library/private-export/page';

const meta = {
  title: 'Library/Private Export/Versioned states',
  id: 'pages-library-private-export-versioned-states',
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

const v1Manifest: ExportManifestV1 = {
  format: EXPORT_FORMAT,
  version: 1,
  exportId: '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa',
  capturedAt: '2026-11-04T12:00:00.000Z',
  expiresAt: '2026-11-04T12:15:00.000Z',
  privacy: EXPORT_PRIVACY,
  completeness: EXPORT_COMPLETENESS,
  sections: [...EXPORT_SECTIONS_V1],
  omissions: {
    trash: 'excluded',
    providerIdentifiers: 'stored evidence only',
    personalImportEvidence: 'retained rows only',
    commerce: 'excluded',
    publication: 'excluded',
    reimport: 'unavailable',
  },
  fullExport: false,
  rows: 1,
  recordBytes: 80,
};

const zeroSectionTotals = Object.fromEntries(
  EXPORT_SECTIONS_V3.map((section) => [section, { rows: 0, recordBytes: 0 }]),
) as ExportSectionTotals;

const v2Manifest: ExportManifestV2 = {
  ...v1Manifest,
  version: 2,
  coverage: EXPORT_V2_COVERAGE,
  sections: [...EXPORT_SECTIONS_V2],
  omissions: {
    ...v1Manifest.omissions,
    reimport: 'V1 recovery plus reviewed V2 annotations and journal dates/reflection; provenance unsupported',
  },
  rows: 0,
  recordBytes: 0,
  sectionTotals: zeroSectionTotals,
};

const v3Manifest: ExportManifestV3 = {
  ...v2Manifest,
  version: 3,
  coverage: EXPORT_V3_COVERAGE,
  sections: [...EXPORT_SECTIONS_V3],
  omissions: {
    ...v1Manifest.omissions,
    reimport: 'V1/V2 recovery only; V3 assessment and V4 provider evidence unsupported',
  },
};

const zeroV4Totals = {
  ...zeroSectionTotals,
  vndbUploads: { rows: 0, recordBytes: 0 },
  vndbEvidence: { rows: 0, recordBytes: 0 },
  anilistUploads: { rows: 0, recordBytes: 0 },
  anilistEvidence: { rows: 0, recordBytes: 0 },
};

const v4Manifest: ExportManifestV4 = {
  ...v3Manifest,
  version: 4,
  coverage: EXPORT_V4_COVERAGE,
  sections: [...EXPORT_SECTIONS_V4],
  omissions: {
    ...v3Manifest.omissions,
    personalImportEvidence:
      'Retained Bangumi, unexpired MAL and VNDB, and retained AniList parsed rows; raw uploads, wrapper documents, credentials and review/apply capabilities excluded',
    reimport:
      'Version 4 recovery unavailable to the installed V1/V2 archive consumer; evidence never authorizes execution',
  },
  rows: 9,
  recordBytes: 1932,
  sectionTotals: {
    ...zeroV4Totals,
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
  manifest: ExportManifest = v4Manifest,
  extra: Partial<ExportJourneySnapshot> = {},
): ExportJourneySnapshot {
  const complete = stage === 'ready' || stage === 'empty' || stage === 'save-failed';
  const captured = stage !== 'coverage';
  return {
    stage,
    busy: stage === 'preparing' || stage === 'capturing' || stage === 'cancelling',
    notice: null,
    exportId: captured ? manifest.exportId : null,
    requestKey: 'illustrative-original-command',
    capturedAt: captured ? manifest.capturedAt : null,
    expiresAt: captured ? manifest.expiresAt : null,
    completeness: captured ? manifest.completeness : null,
    fullExport: false,
    sections: captured ? [...manifest.sections] : [],
    omissions: captured ? manifest.omissions : {},
    pages: complete ? 8 : 0,
    records: complete ? manifest.rows : 0,
    manifest: complete ? manifest : null,
    hasArtifact: complete,
    previousDisposition: null,
    cost: emptyExportCost(),
    ...extra,
  };
}

export const Version4Coverage: Story = {
  name: 'Version 4 coverage (illustrative)',
  render: () => <RoutedState snapshot={snapshot('coverage')} />,
};

export const Version4Capturing: Story = {
  name: 'Version 4 capturing (illustrative)',
  render: () => <RoutedState snapshot={snapshot('capturing', v4Manifest, { records: 7, pages: 5 })} />,
};

export const Version4Ready: Story = {
  name: 'Version 4 ready with provider evidence (illustrative)',
  render: () => <RoutedState snapshot={snapshot('ready')} />,
};

export const Version4SaveFailure: Story = {
  name: 'Version 4 save failure (illustrative)',
  render: () => <RoutedState snapshot={snapshot('save-failed')} />,
};

export const Version4BytesLostReplay: Story = {
  name: 'Version 4 bytes lost, original replay (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('ready', v4Manifest, {
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
      snapshot={snapshot('cancelling', v4Manifest, {
        busy: false,
        pages: 5,
        notice: { kind: 'unknown', command: { kind: 'cancel', exportId: v4Manifest.exportId } },
      })}
    />
  ),
};

export const StoredVersion2Replay: Story = {
  name: 'Stored version 2 replay (illustrative)',
  render: () => (
    <RoutedState snapshot={snapshot('empty', v2Manifest, { notice: { kind: 'bytes-lost' }, hasArtifact: false })} />
  ),
};

export const StoredVersion1Replay: Story = {
  name: 'Stored version 1 replay (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('ready', v1Manifest, { notice: { kind: 'bytes-lost' }, hasArtifact: false, records: 0 })}
    />
  ),
};

export const Version3Assessment: Story = {
  name: 'Version 3 assessment coverage (illustrative)',
  parameters: {
    docs: {
      description: {
        story:
          'The original V3 inventory retains 17 totals and assessment vocabulary. This empty illustrative capture does not manufacture a journal or an absent legacy assessment.',
      },
    },
  },
  render: () => <RoutedState snapshot={snapshot('empty', v3Manifest)} />,
};

export const Version3SaveRetry: Story = {
  name: 'Version 3 exact save retry (illustrative)',
  render: () => <RoutedState snapshot={snapshot('save-failed', v3Manifest)} />,
};

export const Version3FinalTotalsRefusal: Story = {
  name: 'Version 3 final totals refusal (illustrative)',
  parameters: {
    docs: {
      description: { story: 'Mismatched final totals produce no artifact. The installed journey owns this refusal.' },
    },
  },
  render: () => <RoutedState snapshot={snapshot('unavailable', v3Manifest, { notice: { kind: 'malformed' } })} />,
};

export const Version4Empty: Story = {
  name: 'Version 4 empty section totals (illustrative)',
  render: () => (
    <RoutedState
      snapshot={snapshot('empty', { ...v4Manifest, rows: 0, recordBytes: 0, sectionTotals: zeroV4Totals })}
    />
  ),
};
