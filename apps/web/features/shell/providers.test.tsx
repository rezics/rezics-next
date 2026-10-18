import { expect, test } from 'bun:test';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Suspense, use } from 'react';
import { renderToReadableStream, renderToString } from 'react-dom/server';
import { Providers } from './providers.tsx';

function QueryProbe({ viewer, capture }: { viewer: string; capture: (client: QueryClient) => void }) {
  const client = useQueryClient();
  capture(client);
  client.setQueryData(['viewer'], viewer);
  return <p>{client.getQueryData<string>(['viewer'])}</p>;
}

test('Providers supports repeated SSR and keeps query caches private to each request', () => {
  const clients = new Set<QueryClient>();
  for (let index = 0; index < 24; index += 1) {
    let owner: QueryClient | undefined;
    const capture = (client: QueryClient) => {
      if (owner) expect(client).toBe(owner);
      else {
        expect(client.getQueryData(['viewer'])).toBeUndefined();
        owner = client;
      }
    };
    const html = renderToString(<Providers>
      <QueryProbe viewer={`reader-${index}`} capture={capture} />
      <QueryProbe viewer={`reader-${index}`} capture={capture} />
    </Providers>);
    expect(html).toBe(`<p>reader-${index}</p><p>reader-${index}</p>`);
    expect(owner).toBeDefined();
    expect(clients.has(owner!)).toBe(false);
    clients.add(owner!);
  }
});

function DelayedProbe({ ready, viewer }: { ready: Promise<void>; viewer: string }) {
  use(ready);
  return <QueryProbe viewer={viewer} capture={() => {}} />;
}

test('concurrent streaming SSR resumes suspended children without a hook error or client-render fallback', async () => {
  const errors: unknown[] = [];
  const pages = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const ready = Promise.withResolvers<void>();
    const stream = await renderToReadableStream(<Providers>
      <Suspense fallback={<p>Loading</p>}>
        <DelayedProbe ready={ready.promise} viewer={`reader-${index}`} />
      </Suspense>
    </Providers>, { onError(error) { errors.push(error); } });
    ready.resolve();
    await stream.allReady;
    return new Response(stream).text();
  }));
  expect(errors).toEqual([]);
  pages.forEach((html, index) => {
    expect(html).toContain(`<p>reader-${index}</p>`);
    expect(html).not.toContain('<!--$!-->');
    expect(html).not.toContain('Switched to client rendering');
    expect(html).not.toContain('data-msg=');
  });
});
