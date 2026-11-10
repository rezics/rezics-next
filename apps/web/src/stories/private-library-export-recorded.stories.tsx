import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { expect, userEvent, within } from 'storybook/test';
import { PrivateLibraryExportPage } from '../library/private-export/page';
import { LibraryExportPortContext } from '../library/private-export/port';
import { exportRecording, recordedExportPort } from '../library/private-export/recording';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Library/Private Export/Producer recordings',
  id: 'pages-library-private-export-producer-recordings',
  parameters: { layout: 'fullscreen' },
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

const capture: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.library_export_capture() }));
  await expect(await canvas.findByRole('button', { name: m.library_export_download() })).toBeVisible();
  await expect(canvas.getByText(m.library_export_no_reimport())).toBeVisible();
};

export const ProviderEvidence: Story = {
  render: () => <RecordedVisit />,
  play: capture,
};

export const SaveRetry: Story = {
  render: () => <RecordedVisit failSave />,
  play: async (context) => {
    await capture(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_export_download() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_export_retry_save() }));
    await expect(canvas.getByText(m.library_export_downloaded())).toBeVisible();
  },
};

export const StoredVersion1: Story = { render: () => <RecordedVisit version={1} />, play: capture };
