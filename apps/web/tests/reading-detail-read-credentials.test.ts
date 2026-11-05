import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { ReadingAuthority } from '../src/library/reading-detail-current-origin';
import { sessionQuery } from '../src/session/query';
import { viewerExposureLifetime, viewerExposureQuery } from '../src/kernel/viewer-exposure';

test('a signed-in session without CSRF retains authorized reads and has no mutation headers', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: null });
  const lifetime = viewerExposureLifetime(client).getSnapshot();
  if (lifetime.state !== 'signed-in') throw new Error('Expected the signed-in viewer observation');
  client.setQueryData(viewerExposureQuery(lifetime.observation).queryKey, {
    subject: 'owner',
    admitted: ['reading_progress'],
  });
  const authority = new ReadingAuthority(client, ['progress_session.read', 'progress_session.record']);
  const release = authority.subscribe(() => {});
  try {
    const snapshot = authority.read();
    expect(authority.current(snapshot, ['progress_session.read'])).toBe(true);
    expect(authority.current(snapshot, ['progress_session.record'])).toBe(true);
    expect(authority.headers(snapshot, ['progress_session.record'])).toBeNull();
  } finally {
    release();
    await Promise.resolve();
    client.clear();
  }
});
