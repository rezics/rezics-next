import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { planCrossMediaSeed, seedCrossMedia, type CrossMediaTables } from '../../../importer/src/cross-media-seed.ts';
import { showcaseFranchiseSelection } from '../../../importer/src/showcase-franchise.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identitySupport } from './identity-fixture.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = GLOBAL_CONTEXT;
// The pinned minimal Archive pairs observed for the selected franchise; the Bangumi and VNDB grains stay separate.
const roots = { bangumi: [10380, 84148, 51], vndb: ['v2002', 'v4'], includeReleases: false };
const subjects = [
  { id: 10380, type: 2, name: 'STEINS;GATE' },
  { id: 84148, type: 1, name: 'STEINS;GATE' },
  { id: 3154, type: 4, name: 'STEINS;GATE' },
  { id: 129807, type: 2, name: 'STEINS;GATE 0' },
  { id: 247445, type: 1, name: 'STEINS;GATE side story' },
  { id: 51, type: 2, name: 'CLANNAD' },
];
const relations = [
  { subject_id: 10380, related_subject_id: 3154, relation_type: 1 },
  { subject_id: 3154, related_subject_id: 10380, relation_type: 1 },
  { subject_id: 3154, related_subject_id: 84148, relation_type: 1 },
  { subject_id: 84148, related_subject_id: 3154, relation_type: 1 },
  { subject_id: 10380, related_subject_id: 129807, relation_type: 3 },
  { subject_id: 129807, related_subject_id: 10380, relation_type: 2 },
  { subject_id: 3154, related_subject_id: 247445, relation_type: 4006 },
  { subject_id: 247445, related_subject_id: 3154, relation_type: 4012 },
];

function tables(withVndbRelation = true): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield* subjects;
      if (provider === 'bangumi' && table === 'subject-relations') yield* relations;
      if (provider === 'vndb' && table === 'vn_titles')
        for (const key of ['v2002', 'v4', 'v17102'])
          yield { id: key, lang: 'ja', official: 't', title: key === 'v4' ? 'CLANNAD' : 'STEINS;GATE', latin: null };
      if (provider === 'vndb' && table === 'vn')
        for (const key of ['v2002', 'v4', 'v17102']) yield { id: key, olang: 'ja', alias: null };
      if (provider === 'vndb' && table === 'entry_meta')
        for (const key of ['v2002', 'v4', 'v17102'])
          yield { id: key, revision: '1', lastmod: '2026-11-04 00:00:00+00' };
      if (provider === 'vndb' && table === 'vn_extlinks') yield { id: 'v2002', link: 1 };
      if (provider === 'vndb' && table === 'extlinks')
        yield { id: 1, site: 'website', value: 'https://bgm.tv/subject/3154' };
      if (provider === 'vndb' && table === 'vn_relations' && withVndbRelation) {
        yield { id: 'v2002', vid: 'v17102', relation: 'side', official: 't' };
        yield { id: 'v17102', vid: 'v2002', relation: 'par', official: 't' };
      }
    },
  };
}

function subjectId(reading: { subject: unknown }): string {
  const result = reading.subject as { subject?: { id?: string }; id?: string };
  const id = result.subject?.id ?? result.id;
  if (!id) throw new TypeError('Seed reading has no acknowledged subject UUID');
  return id;
}

test('selected franchise relations publish on exact native endpoints after separate adoption and replay without writes', async () => {
  const previous = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = tmpdir();
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'showcase-franchise-native-'));
  try {
    const tierKey = randomUUID();
    const tier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: tierKey, tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
      tierKey,
    );
    expect(tier.status).toBe(200);
    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    async function candidates(subject: string, property: string) {
      const response = await editor.http(
        `/v1/subjects/${subject}/candidates?${new URLSearchParams({ property, context: globalContext, limit: '100' })}`,
      );
      expect(response.status).toBe(200);
      return response.body as {
        candidates: { id: string; head: number | null; retracted: number | null; source?: unknown }[];
        adoption: { head: number } | null;
      };
    }
    // One independent review and adoption per (subject, property): adoption replaces only that property's selection.
    async function acceptAdopt(subject: string, property: string) {
      const seen = new Set<string>();
      for (;;) {
        const listing = await candidates(subject, property);
        const next = listing.candidates.find(
          (candidate) => candidate.source && !candidate.retracted && !seen.has(candidate.id),
        );
        if (!next) {
          const live = listing.candidates.filter((candidate) => !candidate.retracted);
          expect(live.length).toBeGreaterThan(0);
          const adopted = await editor.http(`/v1/subjects/${subject}:adopt`, {
            context: globalContext,
            property,
            mode: 'replace',
            expected_head: listing.adoption?.head ?? null,
            selection: live.map((candidate) => ({ candidate: candidate.id, rank: 'normal' })),
          });
          expect(adopted.status).toBe(200);
          return;
        }
        const accepted = await editor.http(`/v1/subjects/${subject}/candidates/${next.id}:accept`, {
          context: globalContext,
          expected_head: next.head,
        });
        expect(accepted.status).toBe(200);
        seen.add(next.id);
      }
    }
    async function read(subject: string) {
      const response = await editor.http(`/v1/subjects/${subject}?context=${globalContext}`);
      expect(response.status).toBe(200);
      return response.body as {
        subject: {
          id: string;
          statements: Record<
            string,
            {
              value: { content: unknown };
              references: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
            }[]
          >;
        };
      };
    }

    const path = join(directory, 'state.sqlite');
    const destination = { origin: 'https://kernel.import.test' };
    const commands: BatchCommand[] = [];
    const port = {
      ...runtime.importTransport,
      async batch(request: Parameters<typeof runtime.importTransport.batch>[0]) {
        commands.push(...request.commands);
        return runtime.importTransport.batch(request);
      },
    };
    const selection = showcaseFranchiseSelection(roots);
    const initial = await seedCrossMedia(await planCrossMediaSeed(tables(), { selection }), path, port, destination, {
      mediaDeadlineMs: 0,
    });
    expect(initial.unresolved.some((row) => row.reason.startsWith('current_relation_endpoint_'))).toBe(true);
    // Review exact proposal endpoints before the current-reading identity gate can admit them.
    const identities = commands.filter(
      (command) =>
        command.op === 'propose' &&
        (command.statement.property.id === 'wdt:P5732' || command.statement.property.id === 'wdt:P3180'),
    );
    expect(identities.length).toBeGreaterThan(0);
    for (const command of identities) {
      if (command.op !== 'propose') throw new TypeError('Identity review requires a proposal');
      await acceptAdopt(command.subject, command.statement.property.id);
    }
    // Newly reviewed identities resolve unchanged source edges through the original replay intent.
    const first = await seedCrossMedia(await planCrossMediaSeed(tables(), { selection }), path, port, destination, {
      mediaDeadlineMs: 0,
    });
    const native = (source: 'bangumi' | 'vndb', externalId: string) =>
      subjectId(first.readings.find((row) => row.source === source && row.externalId === externalId)!);

    // Bangumi relations are ordinary typed proposals on the endpoint that owns each edge.
    const proposals = (first.workRelations ?? []).flatMap((row) => {
      const command = row.command;
      if (row.status !== 'proposed' || command?.op !== 'propose') return [];
      const value = command.statement.value;
      if (value.type !== 'value') return [];
      return [{ subject: command.subject, property: command.statement.property.id, target: String(value.content) }];
    });
    const bangumiIds = new Set(['10380', '84148', '3154', '129807', '247445'].map((key) => native('bangumi', key)));
    expect(proposals).toHaveLength(4);
    expect(new Set(proposals.map((row) => row.property))).toEqual(
      new Set(['rezics:crossMediaCounterpart', 'rezics:sideStoryOf', 'wdt:P155']),
    );
    for (const row of proposals) {
      expect(bangumiIds.has(row.subject)).toBe(true);
      expect(bangumiIds.has(row.target)).toBe(true);
      expect(row.subject).not.toBe(row.target);
    }

    // The VNDB side/par pair is one directed wdt:P144 assertion with both exact citations and current endpoints.
    const vndb = first.vndbWorkRelations;
    expect(vndb.map((row) => row.relation).sort()).toEqual(['par', 'side']);
    expect(vndb.every((row) => row.delivery === 'acknowledged')).toBe(true);
    expect(new Set(vndb.map((row) => `${row.holderKey}>${row.property}>${row.targetKey}`))).toEqual(
      new Set(['v2002>wdt:P144>v17102']),
    );
    const vndbHolder = native('vndb', 'v2002');
    const vndbTarget = native('vndb', 'v17102');
    expect(vndb.every((row) => row.holderSubjectId === vndbHolder && row.targetSubjectId === vndbTarget)).toBe(true);
    // Selected counterpart evidence links providers; each retains its independent original identity.
    expect(vndbHolder).not.toBe(native('bangumi', '3154'));
    await acceptAdopt(vndbHolder, 'rezics:crossMediaCounterpart');
    const linked = await read(vndbHolder);
    expect(linked.subject.id).toBe(vndbHolder);
    expect(linked.subject.statements['wdt:P3180']?.map((row) => row.value.content)).toContain('v2002');
    expect(linked.subject.statements['rezics:crossMediaCounterpart']?.map((row) => row.value.content)).toContain(
      native('bangumi', '3154'),
    );

    // Separate adoption, then independent current reads show the typed edges on their exact endpoint UUIDs.
    const adopted = new Map<string, { subject: string; property: string; targets: Set<string> }>();
    for (const row of [...proposals, { subject: vndbHolder, property: 'wdt:P144', target: vndbTarget }]) {
      const key = `${row.subject}\0${row.property}`;
      const entry = adopted.get(key) ?? { subject: row.subject, property: row.property, targets: new Set<string>() };
      entry.targets.add(row.target);
      adopted.set(key, entry);
    }
    for (const entry of adopted.values()) await acceptAdopt(entry.subject, entry.property);
    for (const entry of adopted.values()) {
      const current = await read(entry.subject);
      const contents = current.subject.statements[entry.property]?.map((item) => item.value.content) ?? [];
      for (const target of entry.targets) expect(contents).toContain(target);
      for (const statement of current.subject.statements[entry.property] ?? []) {
        const original = commands.find(
          (command) =>
            command.op === 'propose' &&
            command.subject === entry.subject &&
            command.statement.property.id === entry.property &&
            command.statement.value.type === 'value' &&
            command.statement.value.content === statement.value.content,
        );
        expect(original?.op).toBe('propose');
        if (original?.op !== 'propose') throw new TypeError('Published relation has no exact proposal');
        const citations = (
          references: {
            parts: { property: { id: string }; value: { content: unknown } | { type: 'somevalue' | 'novalue' } }[];
          }[],
        ) =>
          references.flatMap((reference) =>
            reference.parts.flatMap((part) =>
              part.property.id === 'schema:url' && 'content' in part.value ? [part.value.content] : [],
            ),
          );
        expect(citations(statement.references)).toEqual(citations(original.statement.references ?? []));
      }
    }

    // Replaying the same source produces no new native writes and the same acknowledged relation set.
    const commandBodies = commands.map((command) => JSON.stringify(command));
    const reopened = await seedCrossMedia(await planCrossMediaSeed(tables(), { selection }), path, port, destination, {
      mediaDeadlineMs: 0,
    });
    expect(commands.map((command) => JSON.stringify(command))).toEqual(commandBodies);
    expect(reopened.workRelations?.map((row) => row.status)).toEqual(first.workRelations?.map((row) => row.status));
    expect(reopened.vndbWorkRelations.map((row) => row.delivery)).toEqual(vndb.map((row) => row.delivery));

    // Removing both source rows retires only the managed relation, through ordinary candidate retraction.
    await seedCrossMedia(await planCrossMediaSeed(tables(false), { selection }), path, port, destination, {
      mediaDeadlineMs: 0,
    });
    const withdrawn = await read(vndbHolder);
    expect(withdrawn.subject.statements['wdt:P144'] ?? []).toEqual([]);
    expect(withdrawn.subject.statements['rezics:crossMediaCounterpart']?.map((row) => row.value.content)).toContain(
      native('bangumi', '3154'),
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
