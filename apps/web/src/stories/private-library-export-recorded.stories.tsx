import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { PrivateLibraryExportPage } from '../library/private-export/page';
import { LibraryExportPortContext } from '../library/private-export/port';
import { exportRecording, recordedExportPort } from '../library/private-export/recording';

const meta = {
  title: 'Library/Private Export/Producer recordings',
  id: 'pages-library-private-export-producer-recordings',
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Manual routed journeys using saved V1/V4 producer HTTP responses at their captured clock. Capture and download start only on your action; delivery is simulated. These stories do not establish current native acceptance. Choose locale and viewport manually.' } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function RecordedVisit({ version = 4, failSave = false }: { version?: 1 | 4; failSave?: boolean }) {
  const [runtime] = useState(() => {
    const capture = exportRecording(version);
    const recording = recordedExportPort(capture);
    const controller = new AbortController();
    let saves = 0;
    return {
      ...recording,
      visit: {
        subject: 'recording-owner',
        csrfToken: 'recording-csrf',
        controller,
        current: () => !controller.signal.aborted,
        retire: () => controller.abort(),
      },
      deliver: () => !(failSave && saves++ === 0),
    };
  });
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({
        component: () => (
          <LibraryExportPortContext.Provider value={runtime.port}>
            <PrivateLibraryExportPage visit={runtime.visit} now={runtime.now} deliver={runtime.deliver} />
          </LibraryExportPortContext.Provider>
        ),
      }),
      history: createMemoryHistory({ initialEntries: ['/en/library/export'] }),
    }),
  );
  return <RouterProvider router={router} />;
}

export const ProviderEvidence: Story = {
  name: 'Version 4 capture and download (producer responses)',
  render: () => <RecordedVisit />,
};

export const SaveRetry: Story = {
  name: 'Version 4 exact save retry (producer responses)',
  parameters: {
    docs: { description: { story: 'Create a capture, choose Download JSON, then Retry download. The first local delivery fails; the second receives the same artifact.' } },
  },
  render: () => <RecordedVisit failSave />,
};

export const StoredVersion1: Story = {
  name: 'Stored version 1 (producer responses)',
  render: () => <RecordedVisit version={1} />,
};
