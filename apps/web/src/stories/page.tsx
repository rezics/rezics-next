import React, { type ReactNode } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  createMemoryHistory,
} from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { AppShell, HomePage, NotFoundPage } from '../shell/shell';
import { createRecordedKernelFetch } from '../kernel/fake';
import subjectRecording from '../kernel/recorded/subject.json';
import missingRecording from '../kernel/recorded/missing-subject.json';
import { getLocale } from '../paraglide/runtime.js';

const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const missingId = '00000000-0000-4000-8000-000000000000';
const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({ subject: subjectRecording, 'missing-subject': missingRecording }),
});

function SubjectPage() {
  const [label, setLabel] = React.useState('');
  React.useEffect(() => {
    void client
      .subjects({ id })
      .get()
      .then(({ data }) => setLabel(data?.subject.labels[getLocale()] ?? data?.subject.labels.en ?? ''));
  }, []);
  return (
    <article>
      <h1 className="font-serif text-4xl font-semibold">{label}</h1>
    </article>
  );
}
function MissingPage() {
  React.useEffect(() => {
    void client.subjects({ id: missingId }).get();
  }, []);
  return <NotFoundPage />;
}
export function PageStory({ visitor, children }: { visitor: 'Signed In' | 'Signed Out'; children: ReactNode }) {
  const root = createRootRoute({
    component: () => (
      <AppShell session={visitor === 'Signed In' ? 'signed-in' : 'signed-out'}>
        <Outlet />
      </AppShell>
    ),
  });
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => <>{children}</> });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

export const pages = {
  home: <HomePage />,
  subject: <SubjectPage />,
  'missing-subject': <MissingPage />,
  shell: <HomePage />,
};
