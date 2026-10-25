import React, { type ReactNode } from 'react';
import { within } from 'storybook/test';
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

const id = subjectRecording.subject.id;
const missingId = '00000000-0000-4000-8000-000000000000';
const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({ subject: subjectRecording, 'missing-subject': missingRecording }),
});

function SubjectPage() {
  const [label, setLabel] = React.useState(
    () => subjectRecording.subject.labels[getLocale()] ?? subjectRecording.subject.labels.en ?? '',
  );
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
  React.useLayoutEffect(() => {
    const moveSkipLink = () => {
      const skipLink = document.querySelector('[data-slot="skip-nav-link"]');
      const header = document.querySelector('header');
      if (skipLink && header && !header.contains(skipLink)) header.appendChild(skipLink);
    };
    moveSkipLink();
    const observer = new MutationObserver(moveSkipLink);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <RouterProvider router={router} />;
}

export const pages = {
  home: <HomePage />,
  subject: <SubjectPage />,
  'missing-subject': <MissingPage />,
  shell: <HomePage />,
};

export async function pageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('main');
}
