import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { sessionQueryKey, signedOutSession } from '../../src/reader/lifetime/contract';

/** Mounted authoring ports own their I/O; preferences get a private, signed-out query client. */
export async function mountAuthoringFixture(content: ReactNode, dispose?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQueryKey, signedOutSession);
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await act(async () => root.unmount());
    } finally {
      client.clear();
      try {
        dispose?.();
      } finally {
        host.remove();
      }
    }
  };
  const render = async (next: ReactNode) => {
    try {
      await act(async () => root.render(createElement(QueryClientProvider, { client, children: next })));
    } catch (error) {
      try {
        await close();
      } finally {
        throw error;
      }
    }
  };
  await render(content);
  return { host, root, render, close };
}
