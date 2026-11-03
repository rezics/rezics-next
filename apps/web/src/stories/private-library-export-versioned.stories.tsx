import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import {
  EXPORT_FORMAT,
  EXPORT_PRIVACY,
  EXPORT_COMPLETENESS,
  EXPORT_SECTIONS_V1,
  type ExportManifestV1,
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

export const Version2Coverage: Story = {
  name: 'New capture coverage (illustrative)',
  parameters: {
    docs: { description: { story: 'Illustrative version 2 coverage; no native response was recorded.' } },
  },
  render: () => (
    <Shell>
      <ExportCoverage busy={false} locked={false} previousDisposition={null} onCapture={() => {}} />
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

export const Version2ManifestRefusal: Story = {
  name: 'Version 2 manifest refusal (illustrative)',
  parameters: {
    docs: {
      description: {
        story: 'Illustrative refusal after a version 2 manifest mismatch. No native response was recorded.',
      },
    },
  },
  render: () => (
    <Shell>
      <ExportTerminal stage="unavailable" />
    </Shell>
  ),
};
