import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import sharp, { type Metadata } from 'sharp';
import type { ImageFixture, Source, Container } from '../../../../../specs/content-media-driver.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { newId, partitionOf } from '../../../src/route/route.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { principalCommandIdentity } from '../../../src/command/command.ts';
import claimMedia from '../../../src/content/claim-media.sql';
import fenceCollection from '../../../src/content/fence-collection.sql';
import type { GrowthDatabase } from '../../support/growth.ts';
import { observeSql } from './sql-observer.ts';
import { createMediaStorage } from './storage.ts';
import type { ContentSystem } from './system.ts';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function embeddedMetadata(metadata: Metadata): string[] {
  const fields = ['exif', 'xmp', 'icc', 'iptc', 'orientation'] as const;
  const found: string[] = fields.filter((field) => metadata[field] !== undefined);
  // Sharp returns the actual EXIF bytes; a GPS IFD pointer identifies its GPS directory.
  if (metadata.exif) {
    const bytes = metadata.exif;
    const base = bytes.subarray(0, 6).toString() === 'Exif\0\0' ? 6 : 0;
    const little = bytes.toString('ascii', base, base + 2) === 'II';
    const u16 = (offset: number) => (little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset));
    const u32 = (offset: number) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
    const ifd = base + u32(base + 4);
    const entries = u16(ifd);
    for (let index = 0; index < entries; index++) if (u16(ifd + 2 + index * 12) === 0x8825) found.push('gps');
  }
  return found.sort();
}

export async function imageSource(kind: ImageFixture): Promise<Source> {
  if (kind === 'malformed') {
    const bytes = new TextEncoder().encode('This is not an image.');
    return { bytes, sha256: digest(bytes), type: 'image/jpeg', orientedWidth: 0, orientedHeight: 0, metadata: [] };
  }
  const [width, height] =
    kind === 'over-pixel'
      ? [6401, 6400]
      : kind === 'oriented-gps'
        ? [1200, 800]
        : kind === 'tiny'
          ? [127, 61]
          : [3000, 1500];
  let image = sharp({ create: { width: width!, height: height!, channels: 3, background: '#b52e64' } });
  if (kind === 'oriented-gps' || kind === 'tiny') {
    image = image.withMetadata({ orientation: kind === 'oriented-gps' ? 6 : 1 }).withExifMerge({
      IFD0: { Artist: 'Private photographer' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '25/1 2/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '121/1 3/1 0/1' },
    });
    if (kind === 'oriented-gps')
      image = image.withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Private location</x:xmpmeta>');
  }
  const full = await image.jpeg().toBuffer();
  const metadata = await sharp(full, { limitInputPixels: false }).metadata();
  const bytes = kind === 'truncated' ? full.subarray(0, Math.min(1024, Math.floor(full.length / 2))) : full;
  return {
    bytes: Uint8Array.from(bytes),
    sha256: digest(bytes),
    type: 'image/jpeg',
    orientedWidth: metadata.autoOrient.width,
    orientedHeight: metadata.autoOrient.height,
    metadata: embeddedMetadata(metadata),
  };
}

/** Provision the real Realm board and its catalogue grants through Kernel HTTP. */
export async function provisionMediaContainers(
  system: ContentSystem,
  options: { namespace?: string } = {},
): Promise<{
  containers: { thread: Container; sibling: Container; remote: Container };
  posts: Map<string, { id: string; revisionId: string }>;
}> {
  const author = system.actors.author;
  await bootstrapRelease(system.database.pool, bundledRelease);
  async function command(path: string, body: Record<string, unknown>, method = 'POST', match?: string) {
    const { response } = await system.transport.capture(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${author.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(match ? { 'if-match': JSON.stringify(match) } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok)
      throw new Error(`Media fixture ${method} ${path} failed (${response.status}): ${await response.text()}`);
    return response.json();
  }
  const { space } = await command('/v1/spaces', { title: 'Media fixture space' });
  const { realm } = await command('/v1/realms', {
    spaceId: space.spaceId,
    title: 'Media fixture realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  const { subject: scheme } = await command('/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Media fixture scheme' },
  });
  const { subject: concept } = await command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Media fixture concept' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await command(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, 'PUT', realm.headRevisionId);
  const { board } = await command(`/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Media fixture board',
    visibility: 'published',
  });
  const posts = new Map<string, { id: string; revisionId: string }>();
  async function create(key: string): Promise<Container> {
    const { response } = await system.transport.capture(
      new Request('https://content.test/v1/threads', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${author.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(key),
        },
        body: JSON.stringify({
          title: 'Media fixture thread',
          body: fromPlainText('Media fixture post'),
          licence: 'MIT',
          subjectIds: [],
          boardId: board.id,
          visibility: 'published',
        }),
      }),
    );
    if (response.status !== 201)
      throw new Error(`Media fixture thread creation failed (${response.status}): ${await response.text()}`);
    const { thread } = await response.json();
    posts.set(thread.id, { id: thread.firstPost.id, revisionId: thread.firstPost.revisionId });
    return { id: thread.id, route: thread.route, partition: partitionOf(thread.route) };
  }
  const key = options.namespace ? `media-thread-${options.namespace}` : 'media-thread';
  const home = threadTarget(system.routeKey, author.actor.accountId, key);
  let siblingKey: string | undefined;
  let remoteKey: string | undefined;
  for (let i = 0; i < 100_000 && (!siblingKey || !remoteKey); i++) {
    const candidate = `${options.namespace ? `media-neighbour-${options.namespace}` : 'media-neighbour'}-${i}`;
    const target = threadTarget(system.routeKey, author.actor.accountId, candidate);
    if (partitionOf(target.route) === partitionOf(home.route)) siblingKey ??= candidate;
    else remoteKey ??= candidate;
  }
  if (!siblingKey || !remoteKey) throw new Error('Could not anchor media fixture containers');
  return {
    containers: { thread: await create(key), sibling: await create(siblingKey), remote: await create(remoteKey) },
    posts,
  };
}

/** Native request/job composition for measurement; setup and seeding are unmeasured. */
export async function mediaGrowthFixture(
  system: ContentSystem,
  db: GrowthDatabase,
  { containers, posts }: Awaited<ReturnType<typeof provisionMediaContainers>>,
) {
  const { createImageJob } = await import('../../../src/content/image-job.ts');
  const { createCollectionJob } = await import('../../../src/content/collection-job.ts');
  const { createErasureJob } = await import('../../../src/content/erasure-job.ts');
  const time = '2030-01-02T00:00:00.000Z';
  await system.clock.setCommandTime(time);
  let configuredTime = time;
  const clock = () => new Date(configuredTime);
  const kernel = createKernel({
    pool: db.pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    clock,
    access: () => system.access,
    content: { cursorNow: () => clock().getTime() },
    writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() + crypto.randomUUID(), overrides: '{}' }),
    ratePeer: () => '127.0.0.1',
  });
  const bytes = createMediaStorage();
  const jobPool = db.openPool({ max: 4 });
  const requests = observeSql(db.pool);
  const jobs = observeSql(jobPool);
  const image = createImageJob(jobPool, bytes.storage);
  const collection = createCollectionJob(jobPool, bytes.storage, { clock });
  const erasure = createErasureJob(jobPool, bytes.storage);
  const source = await imageSource('tiny');
  const container = containers.thread;
  async function send(
    as: 'author' | 'worker' | 'other' | 'otherWorker',
    method: string,
    path: string,
    key: string,
    body?: Record<string, unknown>,
    expected?: number,
  ) {
    const response = await kernel.handle(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${system.actors[as].bearer}`,
          'idempotency-key': JSON.stringify(key),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    if (expected === undefined ? !response.ok : response.status !== expected)
      throw new Error(`Growth ${method} ${path} failed (${response.status}): ${await response.text()}`);
    return response;
  }
  async function reserve(as: 'author' | 'other', key: string, target = container) {
    const response = await send(as, 'POST', '/v1/media', key, {
      containerId: target.id,
      purpose: 'post-image',
      mediaType: source.type,
      byteCount: source.bytes.length,
      sha256: source.sha256,
    });
    return (await response.json()).media as { id: string; key: string };
  }
  const template = await reserve('author', 'growth-template');
  const post = posts.get(container.id)!;
  async function row(table: string, idColumn: string, id: string) {
    return (
      await db.admin.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS value FROM content.${table} t WHERE route=$1 AND ${idColumn}=$2`,
        [container.route, id],
      )
    ).rows[0]!.value;
  }
  const templates = {
    thread: await row('thread', 'thread_id', container.id),
    post: await row('post', 'post_id', post.id),
    revision: await row('revision', 'revision_id', post.revisionId),
    media: await row('media', 'media_id', template.id),
  };
  await send('author', 'DELETE', `/v1/media/${template.id}`, 'growth-template-erase');
  let varyingChangedSet = false;
  let changedKeys: string[] = [];
  let staged: { id: string; key: string; requestId: string };

  async function race(claim: () => Promise<Response>, partition: number, first: 'claim' | 'collection') {
    if (first === 'claim') {
      const claimed = requests.hold({ statement: claimMedia.sql }, 'after');
      const referencing = claim();
      await claimed.entered;
      const fencing = jobs.hold({ statement: fenceCollection.sql }, 'before');
      const collecting = collection.collectPartition(partition, 1);
      await fencing.entered;
      fencing.release();
      claimed.release();
      return Promise.all([referencing, collecting]);
    }
    const fenced = jobs.hold({ statement: fenceCollection.sql }, 'after');
    const collecting = collection.collectPartition(partition, 1);
    await fenced.entered;
    const claiming = requests.hold({ statement: claimMedia.sql }, 'before');
    const referencing = claim();
    await claiming.entered;
    claiming.release();
    fenced.release();
    return Promise.all([referencing, collecting]);
  }

  return {
    async close() {
      await requests.close();
      await jobs.close();
      bytes.close();
    },
    varyChangedSet() {
      varyingChangedSet = true;
    },
    /** One population varies both M and Ut, including the exact measured route. */
    async grow(database: GrowthDatabase, scale: number, previous: number) {
      if (varyingChangedSet) {
        // Isolate intentional Delta/B growth against the now-fixed 2048 unrelated
        // rows. These old reserved fixture rows are setup, never product proof.
        const rows = [];
        changedKeys = [];
        for (let ordinal = 0; ordinal < scale; ordinal++) {
          const mediaId = newId(container.route);
          const key = `m/${mediaId}/original`;
          rows.push({
            ...templates.media,
            media_id: mediaId,
            reservation_request_id: `growth-delta-${scale}-${ordinal}`,
            key,
            created_at: '2030-01-01T00:00:00.000Z',
          });
          await bytes.storage.put(key, source.bytes, { mediaType: source.type });
          changedKeys.push(key);
        }
        await database.admin.query(
          'INSERT INTO content.media SELECT * FROM jsonb_populate_recordset(NULL::content.media,$1::jsonb)',
          [JSON.stringify(rows)],
        );
        await database.admin.query('VACUUM (ANALYZE)');
        return;
      }
      const population = { thread: [], post: [], revision: [], media: [] } as Record<
        keyof typeof templates,
        Record<string, unknown>[]
      >;
      const envelopes = { 'core.receipt': [], 'core.outbox': [], 'editorial.write_basis': [] } as Record<
        string,
        Record<string, unknown>[]
      >;
      const partitions = new Map<number, { partition_no: number; position: number; epoch: number }>();
      const identity = principalCommandIdentity(system.actors.author.actor);
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        const route =
          ordinal % 4 === 0
            ? container.route
            : ordinal % 4 === 2
              ? containers.remote.route
              : (container.route + 16 * (ordinal + 1)) % 65536;
        const partition = partitionOf(route);
        if (!partitions.has(partition)) {
          const { rows } = await database.admin.query<{ position: string; epoch: number }>(
            'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
            [partition],
          );
          partitions.set(partition, {
            partition_no: partition,
            position: Number(rows[0]!.position),
            epoch: rows[0]!.epoch,
          });
        }
        const anchor = partitions.get(partition)!;
        anchor.position++;
        const transactionId = crypto.randomUUID();
        const threadId = newId(route);
        const postId = newId(route);
        const revisionId = newId(route);
        const mediaId = newId(route);
        population.thread.push({ ...templates.thread, route, thread_id: threadId, first_post_id: postId });
        population.post.push({
          ...templates.post,
          route,
          thread_id: threadId,
          post_id: postId,
          head_revision_id: revisionId,
          reply_to_post_id: null,
        });
        population.revision.push({
          ...templates.revision,
          route,
          thread_id: threadId,
          post_id: postId,
          revision_id: revisionId,
        });
        population.media.push({
          ...templates.media,
          route,
          media_id: mediaId,
          container_id: threadId,
          reservation_request_id: `growth-distractor-${ordinal}`,
          key: `m/${mediaId}/original`,
          transaction_id: transactionId,
          // Young unrelated rows must not change the collector's fixed candidate set.
          created_at: '2030-01-01T23:59:59.000Z',
        });
        const envelope = { ...anchor, transaction_id: transactionId };
        envelopes['core.receipt']!.push({
          ...envelope,
          principal_kind: identity.principal.kind,
          principal_id: identity.principal.id,
          command_kind: 'content.media.reserve',
          idempotency_key: `growth-distractor-${ordinal}`,
          request_digest:
            '\\x' +
            createHash('sha256')
              .update(
                canonicalize([
                  identity,
                  'content.media.reserve',
                  {
                    containerId: threadId,
                    purpose: 'post-image',
                    mediaType: source.type,
                    byteCount: source.bytes.length,
                    sha256: source.sha256,
                  },
                ])!,
              )
              .digest('hex'),
          response: { mediaId },
        });
        envelopes['editorial.write_basis']!.push({
          ...envelope,
          principal_kind: identity.principal.kind,
          principal_id: identity.principal.id,
          client_id: identity.basis.clientId,
          requested_by: identity.basis.requestedBy,
        });
        envelopes['core.outbox']!.push({
          partition_no: partition,
          position: anchor.position,
          epoch: anchor.epoch,
          event_seq: 0,
          event_count: 1,
          id: newId(route),
          type: 'com.rezics.content.media.reserved.v1',
          subject: mediaId,
          data: { mediaId, containerId: threadId, actorId: identity.principal.id },
        });
      }
      const client = await database.admin.connect();
      try {
        await client.query('BEGIN');
        for (const table of ['thread', 'post', 'revision', 'media'] as const)
          await client.query(
            `INSERT INTO content.${table} SELECT * FROM jsonb_populate_recordset(NULL::content.${table},$1::jsonb)`,
            [JSON.stringify(population[table])],
          );
        if (scale > previous) {
          for (const [table, rows] of Object.entries(envelopes)) {
            const columns = Object.keys(rows[0]!)
              .map((column) => `"${column}"`)
              .join(',');
            await client.query(
              `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
              [JSON.stringify(rows)],
            );
          }
          await client.query(
            `UPDATE core.partition p SET position=s.position
             FROM jsonb_to_recordset($1::jsonb) AS s(partition_no integer,position bigint)
             WHERE p.partition_no=s.partition_no`,
            [JSON.stringify([...partitions.values()])],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await database.admin.query('VACUUM (ANALYZE)');
      // Stage one genuine old reservation outside capture. Only the collector's
      // production selection/fence/purge/finish is measured for this object.
      configuredTime = '2030-01-01T00:00:00.000Z';
      await system.clock.setCommandTime(configuredTime);
      try {
        const requestId = `growth-collection-${scale}`;
        staged = { ...(await reserve('other', requestId, containers.remote)), requestId };
      } finally {
        configuredTime = time;
        await system.clock.setCommandTime(time);
      }
    },
    /** Fixed B, J=1, lineage, output widths and changed set; every write has a fresh key. */
    async operation(_database: GrowthDatabase, scale: number, repetition: number) {
      const requestStart = requests.records.length;
      const jobStart = jobs.records.length;
      const key = `growth-${repetition}`;
      // Trusted command configuration ages this real reservation without caller
      // clock input or fixture lifecycle updates.
      configuredTime = '2030-01-01T00:00:00.000Z';
      await system.clock.setCommandTime(configuredTime);
      let media: { id: string; key: string };
      try {
        media = await reserve('author', `${key}-reserve`);
      } finally {
        configuredTime = time;
        await system.clock.setCommandTime(time);
      }
      const read = await send('author', 'GET', `/v1/media/${media.id}`, `${key}-read`);
      if ((await read.json()).media.id !== media.id) throw new Error('Growth reservation GET lost its object');
      await bytes.storage.put(media.key, source.bytes, { mediaType: source.type });
      await send('worker', 'POST', `/v1/media/${media.id}:complete`, `${key}-complete`, {
        containerId: container.id,
        reservationRequestId: `${key}-reserve`,
        byteCount: source.bytes.length,
        sha256: source.sha256,
      });
      const processed = await image.process(media.id);
      if (processed.state !== 'available' || processed.variants.length !== 2)
        throw new Error('Growth image job did not publish its fixed native outputs');
      const [, claimFirst] = await race(
        () =>
          send('author', 'POST', `/v1/threads/${container.id}/posts`, `${key}-reference`, {
            body: fromPlainText('Fixed growth reference'),
            licence: 'MIT',
            mediaIds: [media.id],
          }),
        container.partition,
        'claim',
      );
      if (claimFirst.collected !== 0 || !(await bytes.storage.get(media.key)))
        throw new Error('Growth claim-first race deleted committed reference bytes');
      const variant = processed.variants[0]!;
      const download = await send(
        'other',
        'GET',
        `/v1/media/${media.id}:authorizeDownload?variant=${variant.format}-${variant.width}`,
        `${key}-download`,
      );
      const decision = await download.json();
      const output = await bytes.storage.get(decision.key);
      if (!output || digest(output) !== decision.sha256) throw new Error('Growth download lost its native bytes');
      await send('author', 'DELETE', `/v1/media/${media.id}`, `${key}-erase`);
      if ((await erasure.purgeObject(media.id)).outcome !== 'purged') throw new Error('Growth erasure was not purged');
      await bytes.storage.put(staged.key, source.bytes, { mediaType: source.type });
      await send('otherWorker', 'POST', `/v1/media/${staged.id}:complete`, `${key}-remote-complete`, {
        containerId: containers.remote.id,
        reservationRequestId: staged.requestId,
        byteCount: source.bytes.length,
        sha256: source.sha256,
      });
      const remoteImage = await image.process(staged.id);
      if (remoteImage.state !== 'available') throw new Error('Growth remote image was not available');
      const [, collected] = await race(
        () =>
          send(
            'other',
            'POST',
            `/v1/threads/${containers.remote.id}/posts`,
            `${key}-remote-reference`,
            {
              body: fromPlainText('Fixed losing growth reference'),
              licence: 'MIT',
              mediaIds: [staged.id],
            },
            409,
          ),
        containers.remote.partition,
        'collection',
      );
      if (collected.examined !== 1 || collected.collected !== 1)
        throw new Error('Growth collection changed its fixed one-object candidate set');
      if (await bytes.storage.get(staged.key)) throw new Error('Growth collection-first race retained source bytes');
      // Inspection uses the unobserved assertion pool; only product SQL contributes
      // to cost. A losing claim must leave neither a receipt nor a revision link.
      const losing = await db.admin.query(
        `SELECT idempotency_key FROM core.receipt
         WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
           AND command_kind='content.post.create' AND idempotency_key=$3`,
        [containers.remote.partition, system.actors.other.actor.accountId, `${key}-remote-reference`],
      );
      const links = await db.admin.query(
        'SELECT revision_id FROM content.revision WHERE route=$1 AND media_ids @> $2::uuid[]',
        [containers.remote.route, [staged.id]],
      );
      if (losing.rows.length || links.rows.length) throw new Error('Growth losing claim left durable reference state');
      await Bun.write(
        new URL(`../../../../../.temp/media-growth-sql-${scale}.json`, import.meta.url),
        JSON.stringify({ requests: requests.records.slice(requestStart), jobs: jobs.records.slice(jobStart) }),
      );
    },
    async collectChanged(_database: GrowthDatabase, scale: number) {
      const result = await collection.collectPartition(container.partition, scale);
      if (result.examined !== scale || result.collected !== scale)
        throw new Error('Growth collection did not apply its intentional changed set');
      for (const key of changedKeys)
        if ((await bytes.storage.get(key)) !== null) throw new Error('Growth collection left source bytes behind');
    },
  };
}

/** Check the actual warm-up plans without adding a second measured operation. */
export function assertGrowthPointPlans(
  captured: import('../../support/growth.ts').Capture,
  keys: Readonly<Record<string, readonly string[]>>,
): void {
  const seen = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    const relation = `${node.Schema}.${node['Relation Name']}`;
    const columns = keys[relation];
    if (columns && Number(node['Actual Loops']) > 0 && node['Node Type'] !== 'ModifyTable') {
      const condition = String(node['Index Cond'] ?? '');
      if (!String(node['Node Type']).includes('Index') || columns.some((column) => !condition.includes(column)))
        throw new Error(`Expected exact ${relation} probe on ${columns.join(', ')}: ${JSON.stringify(node)}`);
      seen.add(relation);
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(captured.plans);
  for (const relation of Object.keys(keys))
    if (!seen.has(relation)) throw new Error(`Missing executed point probe for ${relation}`);
}

/** Committed command history, including the hot principal and partition, before harness VACUUM. */
export async function seedMediaCommandHistory(
  database: GrowthDatabase,
  route: number,
  principal: string,
  kind: string,
  from: number,
  to: number,
): Promise<void> {
  const { seed } = await import('../../support/growth.ts');
  const partition = partitionOf(route);
  const {
    rows: [anchor],
  } = await database.admin.query<{ position: string; epoch: number }>(
    'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
    [partition],
  );
  await seed(
    database,
    {
      name: 'committed media command history',
      hotPartition: partition,
      hotShare: 1,
      rows: ({ ordinal }) => {
        const transaction_id = newId(route);
        const envelope = {
          partition_no: partition,
          epoch: anchor!.epoch,
          position: Number(anchor!.position) + ordinal - from + 1,
          transaction_id,
        };
        return {
          'core.receipt': [
            {
              ...envelope,
              principal_kind: 'account',
              principal_id: principal,
              command_kind: kind,
              idempotency_key: `growth-history-${ordinal}`,
              request_digest: Buffer.alloc(32),
              response: {},
            },
          ],
          'editorial.write_basis': [
            {
              ...envelope,
              principal_kind: 'account',
              principal_id: principal,
              client_id: 'bulk-importer',
              requested_by: null,
            },
          ],
          'core.outbox': [
            {
              partition_no: partition,
              epoch: envelope.epoch,
              position: envelope.position,
              event_seq: 0,
              event_count: 1,
              id: newId(route),
              type: 'com.rezics.content.media.reserved.v1',
              subject: transaction_id,
              data: {},
            },
          ],
        };
      },
      async finish(admin) {
        await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
          partition,
          Number(anchor!.position) + to - from,
        ]);
      },
    },
    { from, to },
  );
}
