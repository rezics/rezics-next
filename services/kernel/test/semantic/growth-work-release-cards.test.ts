import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { statementSlotId } from '../../src/semantic/item.ts';
import { isRelationProperty } from '../../src/semantic/item.ts';
import {
  workReleaseCardFieldLimit,
  workReleaseCardProperties,
  workReleaseCardResponseBytes,
} from '../../src/semantic/work-release-cards.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import { createListPresentationFixture } from './support/list-presentation-fixture.ts';

test('composed release cards stay keyed at 64, 512 and 4096 unrelated Subjects and obsolete selections', async () => {
  const f = await createListPresentationFixture({ poolMax: 1 });
  try {
    const work = await f.create('wd:Q689445', {}, { en: 'Growth Visual Novel' });
    const platform = await f.create('skos:Concept', {}, { en: 'Growth platform' });
    const release = await f.create('wd:Q20631656', {}, { en: 'Growth release' });
    for (const [property, value] of [
      ['schema:exampleOfWork', work],
      ['schema:gamePlatform', platform],
    ] as const) {
      const candidate = await f.propose(release, property, value);
      await f.adopt(release, property, [candidate]);
    }
    const current = await f.call('GET', `/v1/subjects/${release}`, undefined, 'anonymous');
    expect(current.status).toBe(200);
    const currentRevision = current.body.subject.revision as number;
    const releaseRoute = routeOf(release)!;
    const slot = statementSlotId(release, 'schema:exampleOfWork');
    const observation: { scale: number; memberships: number; releases: number; scalarSlots: number; relationKeys: number; targets: number; partitions: number; bytes: number; cardsBytes: number }[] = [];
    const unrelated: Population = {
      name: 'work-release-cards-unrelated-and-obsolete',
      hotPartition: partitionOf(releaseRoute),
      hotShare: 1,
      rows({ route, ordinal }) {
        const subject = newId(route);
        const created = randomUUID();
        const oldCandidate = newId(releaseRoute);
        const oldTarget = newId(releaseRoute);
        const oldTransaction = randomUUID();
        const revision = currentRevision + ordinal + 1;
        return {
          'semantic.subject': [{
            route,
            subject_id: subject,
            type: 'schema:Book',
            recorded_transaction_id: created,
            visibility: 'visible',
            security_revision: 0,
            current_facts: 1,
            current_release: bundledDigest,
            projection_pending: false,
          }],
          'semantic.revision': [
            { route, subject_id: subject, revision: 1, kind: 'create', release: bundledDigest, recorded_transaction_id: created },
            { route: releaseRoute, subject_id: release, revision, kind: 'propose', release: bundledDigest, recorded_transaction_id: oldTransaction },
          ],
          'semantic.candidate': [{
            route: releaseRoute,
            subject_id: release,
            candidate_id: oldCandidate,
            slot_id: slot,
            property: 'schema:exampleOfWork',
            rank: 'normal',
            statement: {
              property: { id: 'schema:exampleOfWork' },
              value: { type: 'value', content: oldTarget },
              qualifiers: [],
              references: [],
            },
            release: bundledDigest,
            revision,
            origin: 'proposal',
            view_order: 0,
            relation: true,
          }],
          'semantic.fact': [{
            route,
            subject_id: subject,
            slot_id: statementSlotId(subject, 'rdfs:label'),
            log_seq: 1,
            operation: 'assert',
            kind: 'label',
            language: 'en',
            property: null,
            statement_id: null,
            body: 'Unrelated growth row',
            recorded_transaction_id: created,
            release: null,
            relation: false,
          }],
        };
      },
    };
    const observed: typeof observation = [];
    const report = await checkGrowth(f.db, {
      name: 'Work release card composed native read',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      repetitions: 2,
      counted: { read: () => ({}), limits: { connections: 1 }, bounds: { connections: 'constant' } },
      async grow(db, scale, previous) {
        await seed(db, unrelated, { from: previous, to: scale });
      },
      async operation(_db, scale) {
        const page = await f.call(
          'GET',
          `/v1/subjects/${work}/links?property=schema%3AexampleOfWork&limit=20&language=en`,
          undefined,
          'anonymous',
        );
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        expect(page.body.workReleaseCards.state).toBe('available');
        const cards = page.body.workReleaseCards.cards as Record<string, any>[];
        const card = cards.find((entry) => entry.subject === release)!;
        const admitted = workReleaseCardProperties.filter((property) =>
          bundledRelease.types[card.type]?.properties.includes(property) && bundledRelease.properties[property],
        );
        const scalarSlots = admitted.filter((property) => !isRelationProperty(bundledRelease, property)).length;
        const relationSlots = admitted.length - scalarSlots;
        const relationKeys = admitted.filter((property) => isRelationProperty(bundledRelease, property)).reduce(
          (count, property) => count + (card.fields[property]?.state === 'available' ? card.fields[property].statements.length : 0),
          0,
        );
        const targets = new Set(Object.keys(card.related)).size;
        const partitions = new Set([
          work,
          ...cards.map((entry) => entry.subject),
          ...Object.keys(card.related),
        ].map((id) => partitionOf(routeOf(id)!))).size;
        const bytes = Buffer.byteLength(JSON.stringify(page.body), 'utf8');
        const cardsBytes = Buffer.byteLength(JSON.stringify(page.body.workReleaseCards), 'utf8');
        expect(cardsBytes).toBeLessThanOrEqual(workReleaseCardResponseBytes);
        expect(bytes).toBeLessThanOrEqual(workReleaseCardResponseBytes + 20 * 128 * 1024 + 64 * 1024);
        expect(page.body.links).toHaveLength(1);
        expect(card.membership.value.content).toBe(work);
        expect(relationKeys).toBeLessThanOrEqual(relationSlots * workReleaseCardFieldLimit);
        observed.push({ scale, memberships: page.body.links.length, releases: cards.length, scalarSlots, relationKeys, targets, partitions, bytes, cardsBytes });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    expect(report.verdicts.rows.outcome).toBe('compatible');
    expect(report.verdicts.statements.outcome).toBe('compatible');
    expect(observed).toHaveLength(6);
    for (const scale of [64, 512, 4096]) {
      const atScale = observed.filter((entry) => entry.scale === scale);
      expect(atScale).toHaveLength(2);
      expect(atScale[0]).toMatchObject(atScale[1]!);
    }
    expect(new Set(observed.map((entry) => `${entry.memberships}:${entry.releases}:${entry.scalarSlots}:${entry.relationKeys}:${entry.targets}:${entry.partitions}:${entry.bytes}:${entry.cardsBytes}`)).size).toBe(1);
  } finally {
    await f.close();
  }
});
