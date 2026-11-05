import { createKernelClient } from '@rezics/client';
import { useState } from 'react';
import { loadExactRevision, type ExactRevisionState } from '../../threads/exact-revision';
import { ExactRevisionView } from '../../threads/exact-revision-view';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';
import { current, identity, selected } from './fixture';

/** Retry exercises the same typed exact-revision transport with constructed response examples. */
export function ExactRevisionExample({ initial, shell = false }: { initial: ExactRevisionState; shell?: boolean }) {
  const [page, setPage] = useState(initial);
  async function retry() {
    setPage({ state: 'loading' });
    const client = createKernelClient('https://kernel.example', {
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (path === `/v1/posts/${identity.postId}/revisions/${identity.revisionId}`)
            return Response.json({ post: selected });
          if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
          if (path === '/v1/accounts') return Response.json({ accounts: [] });
          throw new Error(`Unexpected example read: ${path}`);
        },
        { preconnect() {} },
      ),
    });
    setPage(await loadExactRevision(client, identity));
  }
  const view = (
    <ExactRevisionView
      identity={identity}
      page={page}
      onRetry={() => {
        void retry();
      }}
    />
  );
  return shell ? (
    <PatternStory path={`/posts/${identity.postId}/revisions/${identity.revisionId}`}>
      <AppShell>{view}</AppShell>
    </PatternStory>
  ) : (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">{view}</div>
  );
}
