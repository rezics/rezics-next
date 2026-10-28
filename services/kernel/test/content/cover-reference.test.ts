import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { claimCoverMedia, checkMediaObject } from '../../src/content/cover-reference.ts';
import { runCommand } from '../../src/command/command.ts';
import type { ClaimMediaInput } from '../../src/content/media.ts';
import { currentCommand, type CommandAuthorization } from '../../src/command/command.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 42000;
const containerId = newId(route);
const uploaderId = newId(42016);
const digest = 'a'.repeat(64);
const request: MediaImportRequest = {
  containerId,
  sourceUrl: 'https://images.example.test/original.jpg',
  credit: {
    rightsHolder: 'Image Artist',
    via: { name: 'Example Catalogue', url: 'https://catalogue.example.test/record/42' },
    license: 'LicenseRef-unknown',
    obligations: [],
  },
  provenance: {
    source: 'example-catalogue',
    external_id: 'record-42',
    record_revision: 'edition-3',
    digest: 'b'.repeat(64),
    converter_revision: 'converter-2',
    field_group: 'cover',
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/42' } },
          { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
          { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
        ],
      },
    ],
  },
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  expect(checkMediaImportRequest(request)).toEqual([]);
});
afterAll(async () => {
  await db?.close();
});

async function reserve(purpose = 'cover') {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
        media_type, byte_count, state, key, transaction_id, source_url, credit, provenance)
     VALUES ($1,$2::uuid,$3,$4,$2::text,$5,NULL,NULL,'reserved',$6,$2::uuid,$7,$8,$9)`,
    [
      route,
      id,
      containerId,
      uploaderId,
      purpose,
      `m/${id}/original`,
      request.sourceUrl,
      request.credit,
      request.provenance,
    ],
  );
  return id;
}
async function available() {
  const id = await reserve();
  await db.admin.query(
    `UPDATE content.media SET state='uploaded', byte_count=256, actual_byte_count=256,
       media_type='image/jpeg', sha256=$3 WHERE route=$1 AND media_id=$2`,
    [route, id, digest],
  );
  await db.admin.query("UPDATE content.media SET state='available' WHERE route=$1 AND media_id=$2", [route, id]);
  return id;
}
async function read(id: string) {
  const client = await db.pool.connect();
  try {
    return await checkMediaObject(client, id, 'cover');
  } finally {
    client.release();
  }
}
async function constraint(sql: string, values: unknown[]) {
  await expect(db.admin.query(sql, values)).rejects.toMatchObject({ code: '23514' });
}

test('URL cover reservation has no invented measurements; website reservations remain strict', async () => {
  const id = await reserve();
  expect(
    (
      await db.admin.query(
        'SELECT byte_count, media_type, sha256, actual_byte_count FROM content.media WHERE route=$1 AND media_id=$2',
        [route, id],
      )
    ).rows,
  ).toEqual([{ byte_count: null, media_type: null, sha256: null, actual_byte_count: null }]);
  expect(await read(id)).toBeNull();
  for (const assignments of [
    "purpose='post-image'",
    "state='uploaded'",
    "state='uploaded', actual_byte_count=256, sha256='" + digest + "'",
    'byte_count=0',
    "media_type='application/octet-stream'",
    'credit=NULL',
    'provenance=NULL',
    'source_url=NULL',
    "provenance=jsonb_set(provenance,'{field_group}','\"summary\"')",
  ])
    await constraint(`UPDATE content.media SET ${assignments} WHERE route=$1 AND media_id=$2`, [route, id]);
  const websiteId = newId(route);
  await db.admin.query(
    `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,
       media_type,byte_count,state,key,transaction_id)
     VALUES ($1,$2::uuid,$3,$4,$2::text,'post-image','image/jpeg',256,'reserved',$5,$2::uuid)`,
    [route, websiteId, containerId, uploaderId, `m/${websiteId}/original`],
  );
  for (const column of ['byte_count', 'media_type'])
    await constraint(`UPDATE content.media SET ${column}=NULL WHERE route=$1 AND media_id=$2`, [route, websiteId]);
  expect(await read(websiteId)).toBeNull();
});

test('available cover returns exact image rights and the original source tuple without claiming or exposing fetch URL', async () => {
  const id = await available();
  const expected = {
    id,
    digest,
    containerId,
    rights: {
      license: 'LicenseRef-unknown',
      obligations: [],
      attribution: '(c) Image Artist; via [Example Catalogue](https://catalogue.example.test/record/42)',
    },
    source: request.provenance,
  };
  expect(await read(id)).toEqual(expected);
  expect(await read(id)).toEqual(expected);
  expect(
    (await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [route, id])).rows,
  ).toEqual([{ claimed_at: null }]);
  expect(JSON.stringify(expected)).not.toContain(request.sourceUrl);
});

test('reference reader denies unknown, malformed, unprocessed, rejected, erased, collection pending and taken down objects', async () => {
  expect(await read(newId(route))).toBeNull();
  expect(await read('not-an-id')).toBeNull();
  const reserved = await reserve();
  expect(await read(reserved)).toBeNull();
  const uploaded = await available();
  await db.admin.query("UPDATE content.media SET state='uploaded' WHERE route=$1 AND media_id=$2", [route, uploaded]);
  expect(await read(uploaded)).toBeNull();
  for (const assignment of [
    "state='rejected', decision='invalid_image'",
    'erased=true, security_revision=security_revision+1',
    'collection_pending=true',
    'taken_down=true, security_revision=1',
  ]) {
    const id = await available();
    await db.admin.query(`UPDATE content.media SET ${assignment} WHERE route=$1 AND media_id=$2`, [route, id]);
    expect(await read(id)).toBeNull();
  }
  const id = await available();
  const alienId = newId(route + 16);
  await constraint('UPDATE content.media SET container_id=$3 WHERE route=$1 AND media_id=$2', [route, id, alienId]);
  expect(await read(alienId)).toBeNull();
});

test('invalid rights or provenance fail closed and governance revision cannot regress or be cleared by refresh', async () => {
  const id = await available();
  await db.admin.query(
    "UPDATE content.media SET credit=jsonb_set(credit,'{license}','\"unknown\"') WHERE route=$1 AND media_id=$2",
    [route, id],
  );
  expect(await read(id)).toBeNull();
  await db.admin.query(
    'UPDATE content.media SET credit=$3, taken_down=true, security_revision=2 WHERE route=$1 AND media_id=$2',
    [route, id, request.credit],
  );
  await db.admin.query('UPDATE content.media SET provenance=$3 WHERE route=$1 AND media_id=$2', [
    route,
    id,
    request.provenance,
  ]);
  expect(await read(id)).toBeNull();
  await constraint('UPDATE content.media SET taken_down=false WHERE route=$1 AND media_id=$2', [route, id]);
  await constraint('UPDATE content.media SET security_revision=1 WHERE route=$1 AND media_id=$2', [route, id]);
});

test('exact cover lookup has bounded actual rows, statements and buffers among same-partition media', async () => {
  const id = await available();
  const report = await checkGrowth(db, {
    name: 'exact cover reference',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const added = Array.from({ length: scale - previous }, () => newId(route));
      await database.admin.query(
        `INSERT INTO content.media
           (route, media_id, container_id, uploader_id, reservation_request_id, purpose,
            media_type, byte_count, state, key, transaction_id, source_url, credit, provenance)
         SELECT $2, id, $3, $4, id::text, 'cover', NULL, NULL, 'reserved', 'm/'||id::text||'/original', id, $5, $6, $7
         FROM unnest($1::uuid[]) AS ids(id)`,
        [added, route, containerId, uploaderId, request.sourceUrl, request.credit, request.provenance],
      );
      await database.admin.query('ANALYZE content.media');
    },
    async operation() {
      expect((await read(id))?.id).toBe(id);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(1);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeLessThanOrEqual(2);
    expect(sample.cost.blocks).toBeGreaterThan(0);
  }
}, 60000);

// These hook tests trust the referencing command's prior authorization. Shared Access,
// semantic proposal persistence and final disclosure remain integration requirements.
function claimInput(id: string): Extract<ClaimMediaInput, { reference: unknown }> & { author: AccountActor } {
  return {
    mediaIds: [id],
    containerId,
    author: {
      kind: 'account',
      accountId: uploaderId,
      clientId: 'cover-importer',
      scopes: [],
      requestedBy: null,
      authnEpoch: 0,
    },
    reference: { kind: 'semantic_candidate', subjectId: containerId, candidateId: newId(route), revision: 7 },
  };
}
const commandOptions = {
  partition: partitionOf(route),
  basis: { actorAccountId: uploaderId, clientId: 'cover-importer', requestedBy: null },
};
const claimEvent = { type: 'com.rezics.test.cover_claimed.v1', data: {} };
async function claimedAt(id: string) {
  return (await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [route, id]))
    .rows[0].claimed_at;
}

test('cover claim uses a live referencing command, locks the exact row and rolls back with proposal failure', async () => {
  const id = await available();
  const input = claimInput(id);
  await expect(claimCoverMedia(db.admin, input)).rejects.toThrow('live command');
  const proposalFailure = new Error('proposal rejected after claim');
  await expect(
    runCommand(db.pool, commandOptions, async (tx) => {
      await claimCoverMedia(tx, input);
      const contender = await db.admin.connect();
      try {
        await contender.query('BEGIN');
        await expect(
          contender.query('SELECT media_id FROM content.media WHERE route=$1 AND media_id=$2 FOR UPDATE NOWAIT', [
            route,
            id,
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await contender.query('ROLLBACK');
        contender.release();
      }
      throw proposalFailure;
    }),
  ).rejects.toBe(proposalFailure);
  expect(await claimedAt(id)).toBeNull();
  await runCommand(db.pool, commandOptions, async (tx) => {
    await claimCoverMedia(tx, input);
    return { value: null, events: [claimEvent] };
  });
  const firstClaim = await claimedAt(id);
  expect(firstClaim).not.toBeNull();
  await runCommand(db.pool, commandOptions, async (tx) => {
    await claimCoverMedia(tx, input);
    return { value: null, events: [claimEvent] };
  });
  expect(await claimedAt(id)).toEqual(firstClaim);
});

test('cover claims deny mismatched author, current container, native revision, route and actual command partition', async () => {
  const id = await available();
  const input = claimInput(id);
  const invalid = [
    { ...input, author: { ...input.author, kind: 'anonymous' as const } },
    { ...input, author: { ...input.author, kind: 'account' as const, accountId: newId(route) } },
    { ...input, containerId: newId(route) },
    { ...input, reference: { ...input.reference, revision: 0 } },
    { ...input, reference: { ...input.reference, candidateId: newId(route + 16) } },
    { ...input, reference: { ...input.reference, subjectId: newId(route + 16) } },
    { ...input, mediaIds: [id, newId(route + 16)] },
    { ...input, mediaIds: Array.from({ length: 33 }, () => newId(route)) },
  ];
  for (const candidate of invalid) {
    await expect(
      runCommand(db.pool, commandOptions, async (tx) => {
        await claimCoverMedia(tx, candidate);
        return { value: null, events: [claimEvent] };
      }),
    ).rejects.toThrow();
    expect(await claimedAt(id)).toBeNull();
  }
  // An object and valid input in one partition cannot be claimed by a live command in another.
  await expect(
    runCommand(db.pool, { ...commandOptions, partition: partitionOf(route + 16) }, async (tx) => {
      await claimCoverMedia(tx, input);
      return { value: null, events: [claimEvent] };
    }),
  ).rejects.toThrow();
  expect(await claimedAt(id)).toBeNull();
  const otherUploader = await available();
  await db.admin.query('UPDATE content.media SET uploader_id=$3 WHERE route=$1 AND media_id=$2', [
    route,
    otherUploader,
    newId(route),
  ]);
  await expect(
    runCommand(db.pool, commandOptions, async (tx) => {
      await claimCoverMedia(tx, { ...input, mediaIds: [id, otherUploader] });
      return { value: null, events: [claimEvent] };
    }),
  ).rejects.toThrow();
  expect(await claimedAt(id)).toBeNull();
});

test('cover claim rejects every unavailable state and wrong purpose inside a native command', async () => {
  for (const assignment of [
    "state='uploaded'",
    "state='rejected', decision='invalid_image'",
    'erased=true, security_revision=security_revision+1',
    'collection_pending=true',
    'taken_down=true, security_revision=1',
    "purpose='post-image'",
    "credit=jsonb_set(credit,'{license}','\"unknown\"')",
  ]) {
    const id = await available();
    await db.admin.query(`UPDATE content.media SET ${assignment} WHERE route=$1 AND media_id=$2`, [route, id]);
    await expect(
      runCommand(db.pool, commandOptions, async (tx) => {
        await claimCoverMedia(tx, claimInput(id));
        return { value: null, events: [claimEvent] };
      }),
    ).rejects.toThrow();
    expect(await claimedAt(id)).toBeNull();
  }
});

async function coverClaimGrowth(beforeClaim?: (ids: string[], scale: number, repetition: number) => Promise<void>) {
  let ids: string[] = [];
  const inputBytes: number[] = [];
  const batchSize = (scale: number) => scale / 256;
  const repetitions = 5;
  const runsPerScale = 1 + repetitions;
  const report = await checkGrowth(db, {
    name: 'explicit cover claim batch',
    repetitions,
    warmups: 1,
    scales: [256, 1024, 4096],
    bounds: { rows: 'linear', statements: 'constant', blocks: 'linear' },
    async grow(database, scale, previous) {
      const added = Array.from({ length: Math.max(scale - previous, runsPerScale * batchSize(scale)) }, () =>
        newId(route),
      );
      await database.admin.query(
        `INSERT INTO content.media
           (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
            actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance)
         SELECT $2,id,$3,$4,id::text,'cover','image/jpeg',256,256,$5,'available',
           'm/'||id::text||'/original',id,$6,$7,$8
         FROM unnest($1::uuid[]) AS ids(id)`,
        [added, route, containerId, uploaderId, digest, request.sourceUrl, request.credit, request.provenance],
      );
      // Every scale supplies one fresh batch for the warm-up and each measured run.
      ids = added;
      const mediaIds = ids.slice(0, batchSize(scale));
      inputBytes.push(Buffer.byteLength(JSON.stringify({ ...claimInput(mediaIds[0]!), mediaIds })));
      await database.admin.query('ANALYZE content.media');
    },
    async operation(database, scale, repetition) {
      // repetition spans scales; select this scale's disjoint batch among its new rows.
      const start = (repetition % runsPerScale) * batchSize(scale);
      const mediaIds = ids.slice(start, start + batchSize(scale));
      await beforeClaim?.(mediaIds, scale, repetition);
      await runCommand(database.pool, commandOptions, async (tx) => {
        // Keep the named claim statement on the generic-plan path, independent of
        // which pooled connection receives a measured run.
        await tx.query("SET LOCAL plan_cache_mode = 'force_generic_plan'");
        await claimCoverMedia(tx, { ...claimInput(mediaIds[0]!), mediaIds });
        return { value: null, events: [claimEvent] };
      });
    },
  });
  return { report, inputBytes, batchSize, runsPerScale };
}

test('every measured cover claim run claims only rows that no earlier run claimed', async () => {
  const runs: { ids: string[]; scale: number; repetition: number; claimedAt: (Date | null)[] }[] = [];
  const { runsPerScale } = await coverClaimGrowth(async (ids, scale, repetition) => {
    const result = await db.admin.query<{ claimed_at: Date | null }>(
      'SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])',
      [route, ids],
    );
    expect(result.rows).toHaveLength(scale / 256);
    runs.push({ ids, scale, repetition, claimedAt: result.rows.map((row) => row.claimed_at) });
  });
  expect(runs.map((run) => run.repetition)).toEqual(Array.from({ length: 3 * runsPerScale }, (_, i) => i));
  const seen = new Set<string>();
  for (const run of runs) {
    expect(run.ids).toHaveLength(run.scale / 256);
    expect(run.claimedAt).toEqual(run.ids.map(() => null));
    for (const id of run.ids) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
}, 60000);

test('intentional cover claim batch growth is linear in changed rows and input bytes', async () => {
  const { report, inputBytes, batchSize } = await coverClaimGrowth();
  console.info(
    'cover claim media blocks:',
    JSON.stringify(report.samples.map(({ scale, cost }) => [scale, cost.relations['content.media']?.blocks])),
  );
  expect(inputBytes[2]! - inputBytes[1]!).toBe(4 * (inputBytes[1]! - inputBytes[0]!));
  for (const sample of report.samples) {
    const media = sample.cost.relations?.['content.media'];
    const mediaRows = media?.rows;
    expect(mediaRows).toBeGreaterThanOrEqual(batchSize(sample.scale));
    expect(mediaRows).toBeLessThanOrEqual(2 * batchSize(sample.scale));
    expect(media?.sequentialScans).toBe(0);
    // Per claimed row: 4 blocks for the index seek + heap fetch, 4 for the heap update
    // (old/new pages, visibility map and free-space map), and 4 per inserted index path
    // (root/branch/leaf + insertion at these scales). Changing claimed_at prevents HOT
    // via media_collection_eligible_idx. The new row writes media_pkey, media_route_key_key,
    // media_route_uploader_id_reservation_request_id_key (20261025104720_content_media.sql),
    // and media_cover_reference_idx (20261025110915_content_cover_media.sql).
    // The eligible and pending partial indexes receive no new entry. Thus 4 + 4 + 4*4 = 24
    // per row, plus 16 fixed blocks allowing a 4-block split for each written index.
    expect(media?.blocks).toBeLessThanOrEqual(16 + 24 * batchSize(sample.scale));
    expect(sample.cost.blocks).toBeGreaterThan(0);
  }
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
}, 60000);

test('a cover claim is admitted under statement:propose or subject:create evaluated on the Global Context, and refused under any other action or resource', async () => {
  const actions = ['statement:propose', 'subject:create', 'subject:update'];
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(uploaderId), uploaderId],
  );
  const access = admittedAccess({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  const author = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 10_000 },
    {
      accountId: uploaderId,
      clientId: 'cover-importer',
      scopes: actions,
      authnEpoch: 1,
    },
  );
  const global = { route: routeOf(GLOBAL_CONTEXT)!, id: GLOBAL_CONTEXT };
  for (const targetRoute of [route, 1]) {
    const target = newId(targetRoute);
    const other = { route: targetRoute, id: newId(targetRoute) };
    for (const resource of [global, other]) {
      for (const action of actions) {
        await db.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
          [resource.route, resource.id, uploaderId, action],
        );
      }
    }
    async function attempt(action: string, resource = global, outside = false, receiptOnly = false) {
      const mediaRoute = outside ? targetRoute + 16 : targetRoute;
      const subject = outside ? newId(mediaRoute) : target;
      const id = newId(mediaRoute);
      await db.admin.query(
        `INSERT INTO content.media
         (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
          actual_byte_count,sha256,state,key,transaction_id,source_url,credit,provenance,
          width,height,thumbhash,average_color)
         VALUES ($1,$2::uuid,$3,$4,$2::uuid::text,'cover','image/jpeg',256,256,$5,'available',
          'm/'||$2::uuid::text||'/original',$2::uuid,$6,$7,$8,1200,1800,decode('AQID','base64'),'#5a4632')`,
        [mediaRoute, id, subject, uploaderId, digest, request.sourceUrl, request.credit, request.provenance],
      );
      const partition = partitionOf(targetRoute);
      const context = { pool: db.pool, deadline: Date.now() + 10_000, partition };
      const authorization =
        resource.id === GLOBAL_CONTEXT && partitionOf(global.route) !== partition
          ? resourceAuthorization({ access, actor: author, action, anchor: globalContextAnchor, context })
          : await accessCommandAuthorization(
              access,
              author,
              action,
              resource,
              context,
              () => new Error('Access denied'),
            );
      const binding: CommandAuthorization = receiptOnly
        ? {
            ...authorization,
            async authorize(tx, attempt, evidence) {
              await authorization.authorize(tx, attempt, evidence);
              return 'receipt-only';
            },
          }
        : authorization;
      const command = runCommand(db.pool, { ...commandOptions, partition, authorization: binding }, async (tx) => {
        expect(currentCommand(tx).authorization).toMatchObject({ action, resource, mode: 'execute' });
        await claimCoverMedia(tx, {
          mediaIds: [id],
          containerId: subject,
          author,
          reference: { kind: 'semantic_candidate', subjectId: subject, candidateId: newId(mediaRoute), revision: 1 },
        });
        return { value: null, events: [claimEvent] };
      });
      if (action === actions[2] || resource.id !== GLOBAL_CONTEXT || outside || receiptOnly) {
        await expect(command).rejects.toThrow(receiptOnly ? undefined : 'Invalid cover reference command context');
        expect(
          (
            await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [
              mediaRoute,
              id,
            ])
          ).rows,
        ).toEqual([{ claimed_at: null }]);
      } else {
        await command;
        expect(
          (
            await db.admin.query('SELECT claimed_at FROM content.media WHERE route=$1 AND media_id=$2', [
              mediaRoute,
              id,
            ])
          ).rows[0].claimed_at,
        ).not.toBeNull();
      }
    }
    for (const action of actions.slice(0, 2)) await attempt(action);
    await attempt(actions[2]!);
    for (const action of actions.slice(0, 2)) {
      await attempt(action, other);
      await attempt(action, global, true);
      await attempt(action, global, false, true);
    }
  }
});
