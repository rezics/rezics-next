import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PublicationHead } from '../../src/community/publication.ts';
import { listPublications, publish, readPublication, reject, withdraw } from '../../src/community/publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import { seed, type Population } from '../support/growth.ts';
import {
  axes,
  containerGrowthFixture,
  type Community,
  type ContainerGrowthFixture,
} from './growth-container-fixture.ts';

const scales = [256, 1024, 4096] as const;
const pageSize = 2;
const deadline = () => Date.now() + 60_000;
const commandContext = () => ({ idempotencyKey: crypto.randomUUID(), deadline: deadline() });
const readContext = (actor: ContainerGrowthFixture['owner']['actor']) => ({ actor, deadline: deadline() });

let f: ContainerGrowthFixture;
let historySeries = 0;
let populationSeries = 0;

function idAt(route: number, milliseconds: number, sequence: number): string {
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(milliseconds);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70;
  bytes[7] = (sequence >>> 24) & 0xff;
  bytes[8] = 0x80 | ((sequence >>> 16) & 0x3f);
  bytes[9] = (sequence >>> 8) & 0xff;
  bytes[10] = route >>> 8;
  bytes[11] = route & 0xff;
  bytes[12] = sequence & 0xff;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function publicationDependencies() {
  return { pool: f.db.pool, access: f.system.access, routeKey: f.system.routeKey };
}

async function createCommunity(visibility: 'public' | 'protected' = 'public'): Promise<Community> {
  const selected = await f.community(visibility);
  await seedGovernanceAuthority(
    f.db.admin,
    routeOf(selected.realm.realmId)!,
    selected.realm.realmId,
    f.owner.actor.accountId,
    ['realm:publish'],
  );
  return selected;
}

async function createSubject(label: string): Promise<string> {
  const { subject } = await f.call<{ subject: { id: string } }>('POST', '/v1/subjects', 201, f.owner, {
    type: 'schema:Book',
    labels: { en: label },
  });
  return subject.id;
}

async function adopted(realmId: string, subjectId: string): Promise<string> {
  const result = await publish(publicationDependencies(), f.owner.actor, { realmId, subjectId }, commandContext());
  expect(result.value.verdict).toBe('adopt');
  return result.value.publicationId;
}

async function withdrawnHistory(realmId: string, subjectId: string): Promise<void> {
  const head = await adopted(realmId, subjectId);
  const result = await withdraw(
    publicationDependencies(),
    f.owner.actor,
    { realmId, subjectId, expectedHead: head },
    commandContext(),
  );
  expect(result.value.verdict).toBe('withdraw');
}

async function createWithdrawnHistorySubject(selected: Community, label: string): Promise<string> {
  const subjectId = await createSubject(label);
  await withdrawnHistory(selected.realm.realmId, subjectId);
  return subjectId;
}

function metadataRows(input: {
  route: number;
  position: number;
  epoch: number;
  transactionId: string;
  idempotencyKey: string;
  command: string;
  response: unknown;
  event: string;
  eventData: unknown;
  realmId: string;
  at: string;
}) {
  return {
    'core.receipt': [
      {
        partition_no: partitionOf(input.route),
        principal_kind: 'account',
        principal_id: f.owner.actor.accountId,
        command_kind: input.command,
        idempotency_key: input.idempotencyKey,
        request_digest: Buffer.alloc(32),
        epoch: input.epoch,
        position: input.position,
        transaction_id: input.transactionId,
        response: input.response,
      },
    ],
    'core.outbox': [
      {
        partition_no: partitionOf(input.route),
        position: input.position,
        event_seq: 0,
        event_count: 1,
        epoch: input.epoch,
        id: crypto.randomUUID(),
        type: input.event,
        subject: input.realmId,
        data: input.eventData,
      },
    ],
    'editorial.write_basis': [
      {
        partition_no: partitionOf(input.route),
        transaction_id: input.transactionId,
        epoch: input.epoch,
        position: input.position,
        principal_kind: 'account',
        principal_id: f.owner.actor.accountId,
        client_id: f.owner.actor.clientId,
        requested_by: null,
        recorded_at: input.at,
      },
    ],
  };
}

function publicationPopulation(
  name: string,
  selected: Community,
  verdict: 'adopt' | 'withdraw',
  at: (ordinal: number) => string,
): (scale: number, previous: number) => Promise<void> {
  const realmId = selected.realm.realmId;
  const route = routeOf(realmId)!;
  const idBase = Date.UTC(2030, 0, 1) + ++populationSeries * 100_000_000;
  let from = 0;
  let positionBase = 0;
  let epoch = 1;
  const population: Population = {
    name,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows({ ordinal }) {
      const createdAt = at(ordinal);
      const subjectId = idAt(route, idBase + ordinal * 1000, ordinal * 4 + 1);
      const publicationId = idAt(route, idBase + ordinal * 1000, ordinal * 4 + 2);
      const transactionId = idAt(route, idBase + ordinal * 1000, ordinal * 4 + 3);
      const value = {
        publicationId,
        realmId,
        subjectId,
        verdict,
        predecessor: null,
        subjectRevisionId: null,
        publishedAt: createdAt,
      };
      return {
        'semantic.subject': [
          { route, subject_id: subjectId, type: 'schema:Book', recorded_transaction_id: transactionId },
        ],
        'community.publication': [
          {
            route,
            publication_id: publicationId,
            realm_id: realmId,
            subject_id: subjectId,
            verdict,
            predecessor: null,
            subject_revision_id: null,
            actor: f.owner.actor.accountId,
            created_at: createdAt,
          },
        ],
        'community.publication_head': [
          {
            route,
            realm_id: realmId,
            subject_id: subjectId,
            publication_id: publicationId,
            verdict,
            published_at: createdAt,
          },
        ],
        ...metadataRows({
          route,
          position: positionBase + ordinal - from + 1,
          epoch,
          transactionId,
          idempotencyKey: `${name}-${ordinal}`,
          command: `community.publication.${verdict === 'adopt' ? 'publish' : 'withdraw'}`,
          response: value,
          event: `com.rezics.community.publication.${verdict === 'adopt' ? 'adopted' : 'withdrawn'}.v1`,
          eventData: value,
          realmId,
          at: createdAt,
        }),
      };
    },
    async finish(admin) {
      await admin.query(
        'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
        [partitionOf(route)],
      );
    },
  };
  return async (scale, previous) => {
    from = previous;
    const current = await f.db.admin.query<{ position: string; epoch: number }>(
      'SELECT position::text, epoch FROM core.partition WHERE partition_no=$1',
      [partitionOf(route)],
    );
    positionBase = Number(current.rows[0]!.position);
    epoch = current.rows[0]!.epoch;
    await seed(f.db, population, { from: previous, to: scale });
  };
}

async function retainedPublicationHistory(
  name: string,
  selected: Community,
  subjectId: string,
): Promise<(scale: number, previous: number) => Promise<void>> {
  const realmId = selected.realm.realmId;
  const route = routeOf(realmId)!;
  const head = await f.db.admin.query<{ publication_id: string }>(
    `SELECT publication_id FROM community.publication_head
     WHERE route=$1 AND realm_id=$2 AND subject_id=$3 AND verdict='withdraw'`,
    [route, realmId, subjectId],
  );
  if (!head.rows[0]) throw new Error('Publication history fixture must start from a withdrawn native slot');
  const firstPredecessor = head.rows[0].publication_id;
  const baseTime = Date.UTC(2040, 0, 1) + ++historySeries * 1_000_000_000;
  const historyId = (ordinal: number) => idAt(route, baseTime + ordinal * 1000, ordinal + 1);
  let from = 0;
  let positionBase = 0;
  let epoch = 1;
  const population: Population = {
    name,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows({ ordinal }) {
      const createdAt = new Date(baseTime + ordinal * 1000).toISOString();
      const publicationId = historyId(ordinal);
      const predecessor = ordinal === 0 ? firstPredecessor : historyId(ordinal - 1);
      const transactionId = idAt(route, baseTime + ordinal * 1000, ordinal + 1_000_000);
      const value = {
        publicationId,
        realmId,
        subjectId,
        verdict: 'withdraw',
        predecessor,
        subjectRevisionId: null,
        publishedAt: createdAt,
      };
      return {
        'community.publication': [
          {
            route,
            publication_id: publicationId,
            realm_id: realmId,
            subject_id: subjectId,
            verdict: 'withdraw',
            predecessor,
            subject_revision_id: null,
            actor: f.owner.actor.accountId,
            created_at: createdAt,
          },
        ],
        ...metadataRows({
          route,
          position: positionBase + ordinal - from + 1,
          epoch,
          transactionId,
          idempotencyKey: `${name}-${ordinal}`,
          command: 'community.publication.withdraw',
          response: value,
          event: 'com.rezics.community.publication.withdrawn.v1',
          eventData: value,
          realmId,
          at: createdAt,
        }),
      };
    },
    async finish(admin, range) {
      if (range.to > range.from) {
        await admin.query(
          `UPDATE community.publication_head
           SET publication_id=$4, verdict='withdraw', published_at=$5
           WHERE route=$1 AND realm_id=$2 AND subject_id=$3`,
          [
            route,
            realmId,
            subjectId,
            historyId(range.to - 1),
            new Date(baseTime + (range.to - 1) * 1000).toISOString(),
          ],
        );
      }
      await admin.query(
        'UPDATE core.partition SET position=(SELECT max(position) FROM core.outbox WHERE partition_no=$1) WHERE partition_no=$1',
        [partitionOf(route)],
      );
    },
  };
  return async (scale, previous) => {
    from = previous;
    const current = await f.db.admin.query<{ position: string; epoch: number }>(
      'SELECT position::text, epoch FROM core.partition WHERE partition_no=$1',
      [partitionOf(route)],
    );
    positionBase = Number(current.rows[0]!.position);
    epoch = current.rows[0]!.epoch;
    await seed(f.db, population, { from: previous, to: scale });
  };
}

async function measureAxes(
  name: string,
  selected: Community,
  historySubject: string,
  operation: () => Promise<unknown>,
  options: {
    populationVerdict?: 'adopt' | 'withdraw';
    populationAt?: (ordinal: number) => string;
    prepare?: () => Promise<void>;
    warmup?: () => Promise<void>;
    requireCommunity?: boolean;
  } = {},
): Promise<void> {
  for (const axis of axes) {
    const seriesName = `publication boundary ${name} ${axis}`;
    const additionalGrowth =
      axis === 'population'
        ? publicationPopulation(
            seriesName,
            selected,
            options.populationVerdict ?? 'withdraw',
            options.populationAt ?? ((ordinal) => new Date(Date.UTC(2095, 0, 1) + ordinal * 1000).toISOString()),
          )
        : await retainedPublicationHistory(seriesName, selected, historySubject);
    await f.measure(seriesName, selected, axis, operation, additionalGrowth, {
      ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
      ...(options.warmup === undefined ? {} : { warmup: options.warmup }),
      ...(options.requireCommunity === undefined ? {} : { requireCommunity: options.requireCommunity }),
    });
  }
}

function pageContext(actor = f.owner.actor) {
  return readContext(actor);
}

beforeAll(async () => {
  f = await containerGrowthFixture();
  await seedGovernanceAuthority(f.db.admin, 0, GLOBAL_CONTEXT, f.owner.actor.accountId, [
    'subject:create',
    'moderation:takedown',
  ]);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

test('empty, denied, deep-cursor, decision, and subject-disappearance publication boundaries remain bounded', async () => {
  const emptyRealm = await createCommunity();
  const emptyHistorySubject = await createWithdrawnHistorySubject(emptyRealm, 'Withdrawn history for empty page');
  const emptyList = async () => {
    const page = await listPublications(publicationDependencies(), emptyRealm.realm.realmId, pageContext(), {
      limit: pageSize,
    });
    expect(page).toEqual({ items: [], next: null });
  };
  await measureAxes('empty page', emptyRealm, emptyHistorySubject, emptyList);

  const protectedRealm = await createCommunity('protected');
  const protectedHistorySubject = await createWithdrawnHistorySubject(protectedRealm, 'Protected retained history');
  const deniedSubject = await createSubject('Protected publication boundary');
  const deniedHead = await adopted(protectedRealm.realm.realmId, deniedSubject);
  const denied = async () => {
    expect(
      await listPublications(publicationDependencies(), protectedRealm.realm.realmId, pageContext(f.outsider.actor), {
        limit: pageSize,
      }),
    ).toBeNull();
    await expect(
      withdraw(
        publicationDependencies(),
        f.outsider.actor,
        { realmId: protectedRealm.realm.realmId, subjectId: deniedSubject, expectedHead: deniedHead },
        commandContext(),
      ),
    ).rejects.toThrow();
  };
  await measureAxes('denied read and write', protectedRealm, protectedHistorySubject, denied, {
    populationVerdict: 'adopt',
    requireCommunity: false,
  });

  const deepRealm = await createCommunity();
  const deepHistorySubject = await createWithdrawnHistorySubject(deepRealm, 'Deep retained publication history');
  const deepSubjects: string[] = [];
  for (let index = 0; index < 10; index++) {
    const subjectId = await createSubject(`Deep publication cursor ${index}`);
    await adopted(deepRealm.realm.realmId, subjectId);
    deepSubjects.push(subjectId);
  }
  let page = await listPublications(publicationDependencies(), deepRealm.realm.realmId, pageContext(), {
    limit: pageSize,
  });
  expect(page?.items).toHaveLength(pageSize);
  expect(typeof page?.next).toBe('string');
  page = await listPublications(publicationDependencies(), deepRealm.realm.realmId, pageContext(), {
    cursor: page!.next!,
    limit: pageSize,
  });
  expect(page?.items).toHaveLength(pageSize);
  expect(typeof page?.next).toBe('string');
  const deepCursor = page!.next!;
  const expectedDeepPage = await listPublications(publicationDependencies(), deepRealm.realm.realmId, pageContext(), {
    cursor: deepCursor,
    limit: pageSize,
  });
  expect(expectedDeepPage?.items).toHaveLength(pageSize);
  expect(expectedDeepPage?.items.every((item: PublicationHead) => deepSubjects.includes(item.subjectId))).toBe(true);
  const deepList = async () => {
    const actual = await listPublications(publicationDependencies(), deepRealm.realm.realmId, pageContext(), {
      cursor: deepCursor,
      limit: pageSize,
    });
    expect(actual).toEqual(expectedDeepPage);
  };
  await measureAxes('deep cursor', deepRealm, deepHistorySubject, deepList, {
    populationVerdict: 'adopt',
    populationAt: (ordinal) => new Date(Date.UTC(2095, 0, 1) + ordinal * 1000).toISOString(),
  });

  const decisionRealm = await createCommunity();
  const decisionHistorySubject = await createWithdrawnHistorySubject(decisionRealm, 'Decision retained history');
  for (const verdict of ['withdraw', 'reject'] as const) {
    const subjectId = await createSubject(`${verdict} publication boundary`);
    let currentHead = await adopted(decisionRealm.realm.realmId, subjectId);
    let isAdopted = true;
    const prepare = async () => {
      if (isAdopted) return;
      const restored = await publish(
        publicationDependencies(),
        f.owner.actor,
        { realmId: decisionRealm.realm.realmId, subjectId, expectedHead: currentHead },
        commandContext(),
      );
      currentHead = restored.value.publicationId;
      isAdopted = true;
    };
    const decide = async () => {
      const input = { realmId: decisionRealm.realm.realmId, subjectId, expectedHead: currentHead };
      const result =
        verdict === 'withdraw'
          ? await withdraw(publicationDependencies(), f.owner.actor, input, commandContext())
          : await reject(publicationDependencies(), f.owner.actor, input, commandContext());
      expect(result.value.verdict).toBe(verdict);
      expect(result.value.predecessor).toBe(currentHead);
      currentHead = result.value.publicationId;
      isAdopted = false;
      expect(
        await readPublication(publicationDependencies(), decisionRealm.realm.realmId, subjectId, pageContext()),
      ).toBeNull();
    };
    await measureAxes(`${verdict} command`, decisionRealm, decisionHistorySubject, decide, {
      populationVerdict: 'adopt',
      prepare,
    });
  }

  const disappearanceRealm = await createCommunity();
  const disappearanceHistorySubject = await createWithdrawnHistorySubject(
    disappearanceRealm,
    'Disappearance retained history',
  );
  const disappearingSubject = await createSubject('Publication subject taken down');
  const adoptedHead = await adopted(disappearanceRealm.realm.realmId, disappearingSubject);
  let takenDown = false;
  const restore = async () => {
    if (!takenDown) return;
    await f.call('POST', `/v1/subjects/${disappearingSubject}:restore`, 200, f.owner, {
      reason: 'Restore between measured lifecycle commands',
    });
    takenDown = false;
  };
  const takeDown = async () => {
    const before = await readPublication(
      publicationDependencies(),
      disappearanceRealm.realm.realmId,
      disappearingSubject,
      pageContext(),
    );
    expect(before?.publicationId).toBe(adoptedHead);
    const visible = await listPublications(publicationDependencies(), disappearanceRealm.realm.realmId, pageContext(), {
      limit: pageSize,
    });
    expect(visible?.items.map((item) => item.subjectId)).toContain(disappearingSubject);
    await f.call('POST', `/v1/subjects/${disappearingSubject}:takedown`, 200, f.owner, {
      notice: {
        complaint: 'Publication subject is no longer available',
        received_at: new Date().toISOString(),
      },
    });
    takenDown = true;
    expect(
      await readPublication(
        publicationDependencies(),
        disappearanceRealm.realm.realmId,
        disappearingSubject,
        pageContext(),
      ),
    ).toBeNull();
    const hidden = await listPublications(publicationDependencies(), disappearanceRealm.realm.realmId, pageContext(), {
      limit: pageSize,
    });
    expect(hidden?.items.map((item) => item.subjectId)).not.toContain(disappearingSubject);
    expect(hidden?.next).toBeNull();
    const slot = await f.db.pool.query<{ publication_id: string; verdict: string }>(
      `SELECT publication_id, verdict FROM community.publication_head
       WHERE route=$1 AND realm_id=$2 AND subject_id=$3`,
      [routeOf(disappearanceRealm.realm.realmId), disappearanceRealm.realm.realmId, disappearingSubject],
    );
    expect(slot.rows).toEqual([{ publication_id: adoptedHead, verdict: 'adopt' }]);
  };
  const warmup = async () => {
    await restore();
    await takeDown();
  };
  await measureAxes(
    'native subject takedown disappearance',
    disappearanceRealm,
    disappearanceHistorySubject,
    takeDown,
    {
      warmup,
      prepare: restore,
      populationVerdict: 'withdraw',
    },
  );
}, 1_200_000);
