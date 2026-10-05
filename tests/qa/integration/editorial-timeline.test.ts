import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { checkedMetadataState, metadataComponent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { startMediaStack } from './media-support.ts';

interface View {
  proposal: { latestRevision: number; decision: { outcome: string } | null };
  timeline: Array<{ sequence: string; kind: string; actor: string; revision: number;
    review: { outcome: string; message: string } | null }>;
  nextCursor: string | null;
}

for (const held of [false, true]) {
  test(`Editorial writes are immediately visible in proposal timelines${held ? ' with an unrelated writer held open' : ''}`, async () => {
    const stack = await startMediaStack('editorial-timeline');
    const blocker = await stack.accessPool.connect();
    try {
      const writer = await stack.member('proposer'), reviewer = await stack.member('reviewer');
      await writer.grant(`agent:control:${writer.actor}`, 'agent.control');
      await reviewer.grant(`agent:control:${reviewer.actor}`, 'agent.control');
      const work = await stack.publicWork(writer.actor);
      await reviewer.grant(`work:review:${work.work}`, 'work.review');
      const store = new EditorialReviewStore(stack.accessPool);
      const deps = { environment: stack.env, access: stack.access, editorialReview: store,
        account: { verify: async (request: Request) => request.headers.get('authorization') === `Bearer ${reviewer.token}`
          ? reviewer.principal : writer.principal } };
      const app = createMainApp(stack.fuseki, deps);
      const request = async <T>(method: string, path: string, body?: object, status = 200, token = writer.token): Promise<T> => {
        const response = await app.handle(new Request(`http://main.local${path}`, { method,
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(),
            ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) }));
        const value: unknown = await response.json();
        expect({ status: response.status, ...(response.status !== status ? { body: value } : {}) }).toEqual({ status });
        return value as T;
      };
      const target = await store.resolveTarget({ work: deps, request: new Request('http://main.local'), actingSubject: '' },
        work.work, 'urn:rezics:context:global');
      const candidate = (description: string) => ({ command: 'work-metadata', state: checkedMetadataState({
        kind: 'header', originalTitle: { value: 'Reviewed Work', language: 'en' },
        localized: [{ language: 'en', title: null, description, mainVersionLabel: null }],
      }) });
      const baseHeads = [{ component: metadataComponent(work.work, candidate('First synopsis').state), head: null }];
      if (held) {
        await blocker.query('BEGIN');
        // This unrelated write allocates an xid older than every proposal event.
        await blocker.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`,
          [`https://rezics.com/id/${randomUUID()}`]);
      }
      const started = performance.now();
      const created = await request<{ proposal: string }>('POST', '/v1/editorial/proposals', {
        profile: 'editorial-proposal-create-v1', kind: 'component-correction',
        target: { resource: target.resource, revision: target.revision, context: target.context },
        candidate: candidate('First synopsis'), baseHeads, evidence: [], actingSubject: writer.actor,
      }, 201);
      const path = `/v1/editorial/proposals/${created.proposal}`;
      const get = (query = '') => request<View>('GET', `${path}?actingSubject=${encodeURIComponent(writer.actor)}${query}`);
      const initial = await get();
      expect(initial.timeline).toMatchObject([{ kind: 'created', actor: writer.actor, revision: 1 }]);
      expect(performance.now() - started).toBeLessThan(2000);
      await request('POST', `${path}/revisions`, { profile: 'editorial-proposal-revise-v1', revision: 1,
        candidate: candidate('Revised synopsis'), baseHeads, evidence: [], actingSubject: writer.actor });
      const revised = await get();
      expect(revised.proposal.latestRevision).toBe(2);
      expect(revised.timeline.map(event => event.kind)).toEqual(['created', 'revised']);
      await request('POST', `${path}/reviews`, { profile: 'editorial-proposal-review-v1', revision: 2,
        outcome: 'comment', message: 'Committed review', actingSubject: reviewer.actor }, 200, reviewer.token);
      expect((await get()).timeline.at(-1)).toMatchObject({ kind: 'reviewed', actor: reviewer.actor,
        review: { outcome: 'comment', message: 'Committed review' } });
      await request('POST', `${path}/withdrawal`, { profile: 'editorial-proposal-withdraw-v1', revision: 2,
        actingSubject: writer.actor });
      const before = await get();
      expect(before.proposal.decision?.outcome).toBe('withdrawn');
      expect(before.timeline.map(event => event.kind)).toEqual(['created', 'revised', 'reviewed', 'withdrawn']);
      const rows = (await stack.accessPool.query<{ entry: string; sequence: string | null }>(
        'SELECT entry::text, sequence::text FROM access.editorial_event WHERE proposal = $1 ORDER BY entry',
        [created.proposal])).rows;
      expect(before.timeline.map(event => event.sequence)).toEqual(rows.map(row => row.entry));
      if (held) expect(rows.every(row => row.sequence === null)).toBe(true);
      const firstPage = await get('&limit=1');
      expect(firstPage.timeline).toEqual(before.timeline.slice(0, 1));
      expect(firstPage.nextCursor).not.toBeNull();
      if (held) await blocker.query('ROLLBACK');
      await stack.accessPool.query('SELECT access.sequence_editorial_events(50)');
      // Numbering notifications neither changes timeline identity nor invalidates a pending-row cursor.
      expect((await get()).timeline).toEqual(before.timeline);
      const paged = [...firstPage.timeline];
      let cursor = firstPage.nextCursor;
      for (let page = 0; cursor && page < 4; page++) {
        const next = await get(`&limit=1&cursor=${encodeURIComponent(cursor)}`);
        paged.push(...next.timeline);
        cursor = next.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(paged).toEqual(before.timeline);
      expect((await store.eventsAfter('0')).filter(event => event.proposal === created.proposal)
        .map(event => event.kind)).toEqual(['created', 'revised', 'reviewed', 'withdrawn']);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await stack.stop();
    }
  });
}
