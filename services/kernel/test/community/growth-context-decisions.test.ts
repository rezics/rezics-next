import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledDigest } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { seed, type Population } from '../support/growth.ts';
import { axes, containerGrowthFixture, type ContainerGrowthFixture } from './growth-container-fixture.ts';

type Subject = {
  id: string;
  type: string;
  labels: Record<string, string>;
  descriptions: Record<string, string>;
  aliases: Record<string, string[]>;
  context: string;
  statements: Record<string, { id: string }[]>;
};
type Candidate = { id: string; decision: string | null; head: number | null };
let f: ContainerGrowthFixture;
beforeAll(async () => {
  f = await containerGrowthFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

const statement = (property: string, content: unknown) => ({
  property: { id: property },
  value: { type: 'value', content },
});

for (const axis of axes)
  for (const visibility of ['public', 'protected'] as const) {
    test(`community Context decisions, fallback and denials stay bounded with ${visibility} ${axis} growth`, async () => {
      const selected = await f.community(visibility);
      const context = selected.realm.contextId;
      const { subject: book } = await f.call<{ subject: Subject }>('POST', '/v1/subjects', 201, f.owner, {
        type: 'schema:Book',
        labels: { en: 'Fixed Global identity' },
        descriptions: { en: 'Fixed Global description' },
        aliases: { en: ['Fixed Global alias'] },
        statements: {
          'schema:datePublished': [
            statement('schema:datePublished', {
              time: '+2010-02-23T00:00:00Z',
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            }),
          ],
          'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
        },
      });
      const candidate = book.statements['schema:datePublished']![0]!.id;
      const path = `/v1/subjects/${book.id}`;
      const candidates = (id: string) => `${path}/candidates?context=${id}&property=schema:datePublished`;
      const read = async (id: string, actor = f.owner) =>
        (await f.call<{ subject: Subject }>('GET', `${path}?context=${id}`, 200, actor)).subject;
      const global = await read(GLOBAL_CONTEXT);
      const globalCandidates = await f.call('GET', candidates(GLOBAL_CONTEXT), 200);
      // A reader has Realm authority only; Context moderation remains independent.
      const reader = f.system.actors.moderator;
      await f.call('POST', '/v1/grants', 201, f.owner, {
        resource: { route: routeOf(selected.realm.realmId), id: selected.realm.realmId },
        subject: { kind: 'account', id: reader.actor.accountId },
        actions: ['realm:read'],
        valid: '(,)',
      });
      const subjectRoute = routeOf(book.id)!;
      const template = (
        await f.db.admin.query<{ slot_id: string; statement: Record<string, unknown> }>(
          'SELECT slot_id, statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
          [subjectRoute, book.id, candidate],
        )
      ).rows[0]!;
      const population: Population = {
        name: `community-context-population-${book.id}`,
        hotPartition: partitionOf(subjectRoute),
        hotShare: 1,
        rows({ route }) {
          const subject = newId(route),
            candidateId = newId(route);
          const transaction = crypto.randomUUID();
          return {
            'semantic.subject': [
              {
                route,
                subject_id: subject,
                type: 'schema:Book',
                recorded_transaction_id: transaction,
                current_release: bundledDigest,
              },
            ],
            'semantic.revision': [1, 2].map((revision) => ({
              route,
              subject_id: subject,
              revision,
              kind: revision === 1 ? 'create' : 'accept',
              release: bundledDigest,
              recorded_transaction_id: crypto.randomUUID(),
            })),
            'semantic.candidate': [
              {
                route,
                subject_id: subject,
                candidate_id: candidateId,
                slot_id: template.slot_id,
                property: 'schema:datePublished',
                rank: 'normal',
                statement: { ...template.statement, id: candidateId },
                release: bundledDigest,
                revision: 1,
                origin: 'compact',
              },
            ],
            'semantic.acceptance': [
              {
                route,
                subject_id: subject,
                context_id: context,
                candidate_id: candidateId,
                head: 1,
                verdict: 'accept',
                revision: 2,
              },
            ],
            'semantic.acceptance_current': [
              {
                route,
                subject_id: subject,
                context_id: context,
                candidate_id: candidateId,
                slot_id: template.slot_id,
                head: 1,
                verdict: 'accept',
                revision: 2,
              },
            ],
          };
        },
      };
      let head: number | null = null;
      const decide = async (verb: 'accept' | 'reject') => {
        const { acceptance } = await f.call<{ acceptance: { head: number; decision: string } }>(
          'POST',
          `${path}/candidates/${candidate}:${verb}`,
          200,
          f.owner,
          { context, expected_head: head },
        );
        expect(acceptance).toMatchObject({ context, candidate, decision: verb, head: (head ?? 0) + 1 });
        head = acceptance.head;
      };
      let historyBaseline = 0;
      const grow = async (scale: number, previous: number) => {
        if (axis === 'history') {
          if (previous === 0)
            historyBaseline = Number(
              (
                await f.db.admin.query(
                  'SELECT count(*) AS count FROM semantic.acceptance WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND candidate_id=$4',
                  [subjectRoute, book.id, context, candidate],
                )
              ).rows[0].count,
            );
          // Native verdicts grow this exact candidate/Context history and its command
          // log. Each pair ends accepted, preserving the fixed visible neighborhood.
          for (let ordinal = previous; ordinal < scale; ordinal++) {
            await decide('reject');
            await decide('accept');
          }
          const result = await f.db.admin.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM semantic.acceptance WHERE route=$1 AND subject_id=$2 AND context_id=$3 AND candidate_id=$4',
            [subjectRoute, book.id, context, candidate],
          );
          expect(result.rows[0]!.count).toBeGreaterThanOrEqual(historyBaseline + scale * 2);
        } else {
          await seed(f.db, population, { from: previous, to: scale });
          const result = await f.db.admin.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM semantic.acceptance_current WHERE route BETWEEN $1 AND $1+15 AND subject_id<>$2 AND context_id=$3',
            [partitionOf(subjectRoute) * 16, book.id, context],
          );
          expect(result.rows[0]!.count).toBeGreaterThanOrEqual(scale);
        }
      };
      await f.measure(
        `community ${visibility} Context local reject accept and Global fallback`,
        selected,
        axis,
        async () => {
          for (const verb of ['reject', 'accept'] as const) {
            await decide(verb);
            const local = await read(context);
            expect(local.context).toBe(context);
            for (const field of ['id', 'type', 'labels', 'descriptions', 'aliases'] as const)
              expect(local[field]).toEqual(global[field]);
            expect(local.statements['schema:inLanguage']).toEqual(global.statements['schema:inLanguage']);
            expect(local.statements['schema:datePublished'] ?? []).toEqual(
              verb === 'reject' ? [] : global.statements['schema:datePublished'],
            );
            const page = await f.call<{ candidates: Candidate[] }>('GET', candidates(context), 200);
            expect(page.candidates).toContainEqual(
              expect.objectContaining({
                id: candidate,
                decision: verb === 'reject' ? 'rejected' : 'accepted',
                head,
              }),
            );
            expect((await read(GLOBAL_CONTEXT)).statements).toEqual(global.statements);
            expect(await f.call('GET', candidates(GLOBAL_CONTEXT), 200)).toEqual(globalCandidates);
          }
        },
        grow,
      );
      await f.measure(
        `community ${visibility} Context denied decisions and protected reads`,
        selected,
        axis,
        async () => {
          const before = await f.call('GET', candidates(context), 200);
          for (const verb of ['accept', 'reject'] as const) {
            const denied = await f.call('POST', `${path}/candidates/${candidate}:${verb}`, 403, reader, {
              context,
              expected_head: head,
            });
            expect(denied).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
          }
          expect(await f.call('GET', candidates(context), 200)).toEqual(before);
          expect((await read(context, reader)).statements).toEqual(global.statements);
          if (visibility === 'protected') {
            const unknown = newId(routeOf(context)!);
            for (const actor of [null, f.outsider])
              for (const endpoint of [(id: string) => `${path}?context=${id}`, candidates]) {
                const known = await f.call<Record<string, unknown>>('GET', endpoint(context), 404, actor);
                const missing = await f.call<Record<string, unknown>>('GET', endpoint(unknown), 404, actor);
                const { request_id: _known, ...hidden } = known;
                const { request_id: _missing, ...absent } = missing;
                expect(hidden).toEqual(absent);
                expect(hidden).toMatchObject({ code: 'not_found' });
                expect(JSON.stringify(hidden)).not.toContain(book.labels.en!);
              }
          } else {
            const local = await f.call<{ subject: Subject }>('GET', `${path}?context=${context}`, 200, null);
            expect(local.subject.statements).toEqual(global.statements);
          }
        },
        grow,
      );
    }, 1_800_000);
  }
