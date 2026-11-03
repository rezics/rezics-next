import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
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
  type ExportManifestV1,
  type ExportManifestV2,
  type ExportManifestV3,
  type ExportManifestV4,
} from '../library/private-export/contract';
import { ExportCoverage } from '../library/private-export/coverage';
import { ExportTerminal } from '../library/private-export/states';
import { ExportReady } from '../library/private-export/ready';
import { PageHeading } from '../shell/page-heading';

const meta = {
  title: 'Pages/Library/Private Export/Versioned states',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative versioned private Library export states. No native response was recorded for these stories.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_export_title()}</PageHeading>
      {children}
    </main>
  );
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
  ...v1Manifest,
  version: 3,
  coverage: EXPORT_V3_COVERAGE,
  sections: [...EXPORT_SECTIONS_V3],
  omissions: {
    ...v1Manifest.omissions,
    reimport: 'V1/V2 recovery only; V3 assessment and V4 provider evidence unsupported',
  },
  rows: 0,
  recordBytes: 0,
  sectionTotals: zeroSectionTotals,
};

export const Version4Coverage: Story = {
  name: 'New capture coverage (illustrative)',
  parameters: {
    docs: { description: { story: 'Illustrative version 4 coverage; no native response was recorded.' } },
  },
  render: () => (
    <Shell>
      <ExportCoverage busy={false} locked={false} previousDisposition={null} onCapture={() => {}} />
    </Shell>
  ),
};

export const StoredVersion2Replay: Story = {
  name: 'Stored version 2 replay (illustrative)',
  parameters: {
    docs: {
      description: {
        story: 'Stored version 2 retains its original coverage and cursor; no native response was recorded.',
      },
    },
  },
  render: () => (
    <Shell>
      <ExportReady
        empty
        saveFailed={false}
        bytesLost
        manifest={v2Manifest}
        busy={false}
        onDownload={() => {}}
        onReplay={() => {}}
      />
    </Shell>
  ),
};

export const StoredVersion1Replay: Story = {
  name: 'Stored version 1 replay (illustrative)',
  parameters: {
    docs: {
      description: {
        story:
          'Illustrative stored version 1 capture. Replay uses its original first cursor; no response was recorded.',
      },
    },
  },
  render: () => (
    <Shell>
      <ExportReady
        empty={false}
        saveFailed={false}
        bytesLost
        manifest={v1Manifest}
        busy={false}
        onDownload={() => {}}
        onReplay={() => {}}
      />
    </Shell>
  ),
};

export const Version3Assessment: Story = {
  name: 'Version 3 assessment coverage (illustrative)',
  parameters: {
    docs: {
      description: {
        story:
          'The V3 manifest counts all 17 sections, including empty journals. Its native journal records carry assessment revision 1 and units 0 through 20 or null; missing assessment in V1/V2 remains absent. No native response was recorded.',
      },
    },
  },
  render: () => (
    <Shell>
      <ExportReady
        empty
        saveFailed={false}
        bytesLost={false}
        manifest={v3Manifest}
        busy={false}
        onDownload={() => {}}
        onReplay={() => {}}
      />
    </Shell>
  ),
};

export const Version3SaveRetry: Story = {
  name: 'Version 3 exact save retry (illustrative)',
  parameters: {
    docs: { description: { story: 'The completed V3 bytes remain available after a local save failure.' } },
  },
  render: () => (
    <Shell>
      <ExportReady
        empty
        saveFailed
        bytesLost={false}
        manifest={v3Manifest}
        busy={false}
        onDownload={() => {}}
        onReplay={() => {}}
      />
    </Shell>
  ),
};

export const Version3FinalTotalsRefusal: Story = {
  name: 'Version 3 final totals refusal (illustrative)',
  parameters: {
    docs: { description: { story: 'Mismatched final section totals produce no artifact.' } },
  },
  render: () => (
    <Shell>
      <ExportTerminal stage="unavailable" />
      <p>{m.library_export_no_reimport()}</p>
    </Shell>
  ),
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
  sectionTotals: {
    ...zeroSectionTotals,
    vndbUploads: { rows: 0, recordBytes: 0 },
    vndbEvidence: { rows: 0, recordBytes: 0 },
    anilistUploads: { rows: 0, recordBytes: 0 },
    anilistEvidence: { rows: 0, recordBytes: 0 },
  },
};

export const Version4Empty: Story = {
  name: 'Version 4 empty section totals (illustrative)',
  parameters: {
    docs: {
      description: {
        story:
          'Published V4 inventory and all 21 totals. Provider evidence remains private and inert; recovery is unavailable. This is illustrative, not a native recording.',
      },
    },
  },
  render: () => (
    <Shell>
      <ExportReady
        empty
        saveFailed={false}
        bytesLost={false}
        manifest={v4Manifest}
        busy={false}
        onDownload={() => {}}
        onReplay={() => {}}
      />
    </Shell>
  ),
};
