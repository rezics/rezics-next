import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo } from 'react';
import { EntryFormPage } from '../library/entry-undo';
import { getLocale } from '../paraglide/runtime.js';

const meta = { title: 'Pages/Library/Entry Removal', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The document returned by a native POST. It needs no scripts to submit the receipt. */
function NativeUndoPage() {
  const client = useMemo(() => {
    const client = new QueryClient();
    const admitted = ['personal_library', 'library_entry.restore'];
    client.setQueryData(['session'], { state: 'signed-in', csrfToken: 'story-csrf-token' });
    client.setQueryData(['exposure', 'anonymous'], admitted);
    client.setQueryData(['exposure', 'viewer'], admitted);
    return client;
  }, []);
  return (
    <QueryClientProvider client={client}>
      <EntryFormPage
        locale={getLocale()}
        csrfToken="story-csrf-token"
        returnTo={`/${getLocale()}/library`}
        undo={{ subjectId: 'book-one', deletionId: 'undo-ok', revision: 12 }}
      />
    </QueryClientProvider>
  );
}
export const NoJavaScriptUndo: Story = { name: 'No JavaScript / Undo form', render: () => <NativeUndoPage /> };
