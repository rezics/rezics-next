import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { SubjectPage } from '../features/pages/subject';
import { subjectPageMessages } from '../features/pages/route-support';
import { qualifiedRelationsPage, qualifiedRealm } from '../kernel/fake/qualified-relations';
import { getLocale } from '../paraglide/runtime.js';
const meta = { title: 'Pages/Subjects/Qualified Relations', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function QualifiedRelationsReader({ error = false }: { error?: boolean }) {
  const [client] = useState(() => new QueryClient());
  const page = qualifiedRelationsPage(
    error ? { realm: qualifiedRealm, continuation: { node: 'cast', cursor: 'refuse' }, error: 409 } : {},
  );
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
        <SubjectPage page={page} locale={getLocale()} messages={subjectPageMessages()} renderJsonLd={false} />
      </main>
    </QueryClientProvider>
  );
}
export const Reader: Story = { render: () => <QualifiedRelationsReader /> };
export const ContextConflict: Story = { render: () => <QualifiedRelationsReader error /> };
