import { expect, test } from 'bun:test';
import { rejectClassifiedStatement, shareClassificationContext,
  type ClassificationPost, type ClassificationResolution } from '../../../scripts/dev/seed/classified-statement.ts';
import { acceptBookConcept } from '../../../scripts/dev/seed/genres-step.ts';
import { seedKey } from '../../../scripts/dev/seed/plan.ts';
import type { SeedState } from '../../../scripts/dev/seed/state.ts';
import { classifyVnWork, type SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { startHomeStack } from './feed-read-support.ts';

test('genre and visual-novel seeds revise a later Global rejection with a fresh decision key', async () => {
  const home = await startHomeStack('classification-seed-replay');
  try {
    const { stack, author, call, json } = home;
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['context:create:root', 'context.create'], [`statement:speak:${author.actor}`, 'statement.record'],
      ['classification:decide:global', 'statement.decide']] as const) await author.grant(scope, action);
    const term = await json<{ scheme: string; schemeHead: string; concept: string; sense: string;
      definitionRevision: string }>(await call('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: 'Seed replay topic' }], alternativeLabels: [], broader: [], narrower: [],
      actingSubject: author.actor,
    }, author.token), 201);
    const writes: { key: string; outcome: string; expectedDecisionHead: string | null }[] = [];
    const record = (path: string, body: unknown, key: string) => {
      if (path === '/v1/statement-decisions') {
        writes.push({ key, ...body as { outcome: string; expectedDecisionHead: string | null } });
      }
    };
    const post: ClassificationPost = async <T>(path: string, body: unknown, _token: string, key: string) => {
      const response = await call('POST', path, body, author.token, key);
      expect([200, 201]).toContain(response.status);
      const result = await json<T>(response, response.status);
      record(path, body, key);
      return result;
    };
    const interpretation = await shareClassificationContext(post, author.token, author.actor, [term],
      seedKey('replay-context', 'shared'));
    const state = { api: { post } } as unknown as SeedState;
    const steward = { id: 'author', accountId: author.principal.subject, cookie: '', token: author.token,
      issuedAt: Date.now(), actingSubject: author.actor };
    const port: SeedPort = { actingSubject: author.actor, grant: author.grant,
      request: async (method, path, body, key) => {
        const response = await call(method, path, body, author.token, key);
        if (response.ok && key) record(path, body, key);
        return { status: response.status, body: await response.json() };
      } };
    for (const kind of ['genre', 'visual-novel'] as const) {
      const work = await stack.publicWork(author.actor, ['en'], `${kind} replay Work`);
      const seed = () => kind === 'genre'
        ? acceptBookConcept(state, work, term, { kind: 'global' }, interpretation, steward, 'replay:topic:global')
        : classifyVnWork(port, work, term, interpretation, 'replay-vn');
      const resolve = () => post<ClassificationResolution>('/v1/classification-resolutions', {
        profile: 'classification-resolution-v1', context: { kind: 'global' }, work: work.work,
        mainVersion: work.mainVersion, sense: term.sense,
      }, author.token, seedKey('replay-resolution', kind));

      const before = writes.length;
      await seed();
      const accepted = await resolve();
      expect(accepted).toMatchObject({ state: 'accepted', source: 'global' });
      expect(accepted.decision).not.toBeNull();
      await rejectClassifiedStatement(post, author.token, author.actor, work, term.concept, interpretation,
        { kind: 'global' }, accepted, { statement: seedKey('replay-reject-statement', kind),
          decision: seedKey('replay-rejection', kind) });
      const rejected = await resolve();
      expect(rejected).toMatchObject({ state: 'rejected', source: 'global' });
      expect(rejected.decision).not.toBe(accepted.decision);

      await seed();
      const reseeded = await resolve();
      expect(reseeded).toMatchObject({ state: 'accepted', source: 'global' });
      expect(reseeded.decision).not.toBe(rejected.decision);
      const acceptances = writes.slice(before).filter(write => write.outcome === 'accepted');
      expect(acceptances).toHaveLength(2);
      expect(acceptances[0]?.expectedDecisionHead).toBeNull();
      expect(acceptances[1]?.expectedDecisionHead).toBe(rejected.decision);
      expect(acceptances[1]?.key).not.toBe(acceptances[0]?.key);
      const after = writes.length;
      await seed();
      expect(writes).toHaveLength(after);
    }
  } finally { await home.stop(); }
}, 300_000);
