import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { canReadCompositionResource } from '../../../services/main/src/modules/composition/disclosure-read.ts';
import { changeAdmittedComposition }
  from '../../../services/main/src/modules/structure/change-admitted.ts';
import type { CompositionOperation } from '../../../services/main/src/modules/structure/change.ts';
import { upgradeStoredMembership }
  from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { readCompositionOccurrenceByQualifierKey }
  from '../../../services/main/src/modules/structure/read.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable }
  from '../../../services/main/src/modules/structure/tree.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { workRead, WorkReadMoved } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from './media-support.ts';
import { isForegroundOperation } from './support/operation-cost.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const short = (reference: string) => reference.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Changed { revision: string; occurrences: string[] }
interface ManifestShape {
  records: { page: string; level: number; count: number };
  order: { page: string; level: number; count: number };
  qualifierKeys?: { sourceRoot: string; root: { page: string; level: number; count: number } };
}

// Writes use the existing Zone API and admitted Structure command. The retained
// lookup consumes real Jena/S3 state and current Access/disclosure owners.
test('retained qualifier keys resolve current/exact Zone mounts without scanning unrelated order placements', async () => {
  const prepared = performance.now();
  const stack = await startMediaStack('composition-qualifier-key');
  const originalCommand = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
  stack.fuseki.commandWithReceipt = async envelope => {
    const result = await originalCommand(envelope);
    if (result.status === 'invalid' || result.status === 'unknown-profile') {
      console.log('Retained qualifier producer validation', JSON.stringify({
        status: result.status, report: result.status === 'invalid' ? result.report : undefined, validations: envelope.validations,
      }));
    }
    return result;
  };
  const objects = stack.objects('semantic/structure/');
  await objects.initialize();
  let measuring = false, pages = 0, bytes = 0, orderReads = 0, writes = 0, writeBytes = 0;
  const evidence: object[] = [];
  let override: ((digest: string, value: Uint8Array) => Uint8Array | Promise<Uint8Array>) | undefined;
  const counted: ImmutableObjects = {
    get: async digest => {
      let value = await objects.get(digest);
      if (override) value = await override(digest, value);
      if (measuring && isForegroundOperation()) {
        pages++; bytes += value.byteLength;
        const page = JSON.parse(new TextDecoder().decode(value)) as { tree?: string };
        if (page.tree === 'order') orderReads++;
      }
      return value;
    },
    put: async value => {
      if (measuring && isForegroundOperation()) { writes++; writeBytes += value.byteLength; }
      return objects.put(value);
    },
  };
  Object.assign(stack.env, { structureObjects: counted });
  try {
    // QA restores raw graph state; the native owner requires exhaustive
    // baseline preparation before a second member enters a populated parent.
    const preparedMembership = await upgradeStoredMembership(stack.env);
    expect(preparedMembership.complete).toBe(true);
    console.log('Retained qualifier native preparation', JSON.stringify({
      complete: preparedMembership.complete, placements: preparedMembership.placements,
      receipts: preparedMembership.receipts.length, milliseconds: performance.now() - prepared,
    }));
    const editor = await stack.member('qualifier-editor');
    const outsider = await stack.member('qualifier-outsider');
    const account = { verify: async (request: Request) => {
      const token = request.headers.get('authorization');
      if (token === `Bearer ${editor.token}`) return editor.principal;
      if (token === `Bearer ${outsider.token}`) return outsider.principal;
      throw new Error('Unknown fixture Account assertion');
    } };
    const deps = { environment: stack.env, access: stack.access, account };
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Retained qualifier keys', capabilities: ['realm'], actingSubject: editor.actor,
    }), 201);
    const zone = native(), collection = native(), privateCollection = native();
    for (const [reference, disclosure] of [[collection, 'public'], [privateCollection, 'private']] as const) {
      await editor.grant(`collection:edit:${reference}`, 'collection.edit');
      await editor.grant(`semantic:read:${reference}`, 'semantic.read');
      await json(await editor.send('POST', '/v1/collections', { collection: reference,
        name: `${disclosure} qualifier target`, disclosure, actingSubject: editor.actor }), 201);
    }
    await editor.grant(`zone:edit:${zone}`, 'zone.edit');
    await editor.grant(`semantic:read:${zone}`, 'semantic.read');
    const created = await json<{ navigation: string; revision: string }>(await editor.send('POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', actingSubject: editor.actor,
    }), 201);
    const structure = created.navigation, zonePath = `/v1/zones/${short(zone)}`;
    let head = created.revision;
    const mount = async (target: string, segment: string, disclosure: 'public' | 'private' = 'public') => {
      const result = await json<Changed>(await editor.send('POST', `${zonePath}/mounts`, {
        expectedHead: head, target, routeSegment: segment, disclosure, actingSubject: editor.actor,
      }));
      head = result.revision;
      return result;
    };
    const selected = await mount(collection, 'selected');
    const privateMount = await mount(collection, 'private-mount', 'private');
    const restrictedMount = await mount(privateCollection, 'private-target');
    const retained = head;
    const retainedDigest = (await readCompositionHeader(stack.env, structure))!.manifest.slice(-64);
    const retainedBytes = await objects.get(retainedDigest);
    const requestFor = (member?: typeof editor) => new Request('http://main.local/v1/compositions/retained-key', {
      headers: member ? { authorization: `Bearer ${member.token}` } : {},
    });
    const lookup = (segment: string, revision?: string, member?: typeof editor) => workRead(deps,
      requestFor(member), member ? { actingSubject: member.actor } : {}, async session => {
        const owner = await readZoneConfiguration(stack.env, zone);
        const canReadOwner = async (reference: string) => {
          if (reference !== zone) return false;
          const state = await readZoneConfiguration(stack.env, reference);
          if (state.state !== 'active') return false;
          const publicOwner = state.disclosure === 'public' && (await stack.fuseki.query(`ASK {
            GRAPH ${iri(GRAPHS.current)} { ${iri(state.space)} <${RV}disclosure> <${RV}Public> } }`)).boolean === true;
          return publicOwner || stack.access.canReadSemanticResource(session.principal,
            session.options.actingSubject ?? null, reference);
        };
        const canReadTarget = (target: string) => canReadCompositionResource(session, target);
        const privateMounts = !!session.principal && !!session.options.actingSubject
          && await stack.access.canReadSemanticResource(session.principal, session.options.actingSubject, zone);
        const result = await readCompositionOccurrenceByQualifierKey(stack.env, {
          structure, ...(revision ? { revision } : {}), key: { type: 'zone-mount', zone, routeSegment: segment },
          canReadOwner, canReadTarget,
          visible: record => record.qualifier?.type === 'zone-mount'
            && (record.qualifier.disclosure === 'public' || privateMounts),
        });
        // Membership and its key grant no rights; finish with the target owner.
        for (const record of result.occurrences) {
          if (record.target && !await canReadTarget(record.target)) throw new WorkReadMoved('Target disclosure moved');
          if (record.qualifier?.type === 'zone-mount' && record.qualifier.disclosure === 'private'
            && !await stack.access.canReadSemanticResource(session.principal,
              session.options.actingSubject ?? null, zone)) throw new WorkReadMoved('Private mount grant moved');
        }
        const finalOwner = await readZoneConfiguration(stack.env, zone);
        if (finalOwner.revision !== owner.revision || finalOwner.state !== 'active') {
          throw new WorkReadMoved('Zone owner moved');
        }
        return result;
      });
    const measured = async (label: string, segment: string, revision?: string, member?: typeof editor) => {
      pages = 0; bytes = 0; orderReads = 0; writes = 0; writeBytes = 0;
      const graphBefore = stack.fuseki.queries, sqlBefore = stack.accessPool.checkouts;
      const started = performance.now();
      measuring = true;
      let result: Awaited<ReturnType<typeof lookup>>;
      try { result = await lookup(segment, revision, member); }
      finally { measuring = false; }
      const elapsed = performance.now() - started;
      const sample = { label, pages, bytes, orderReads, writes, graphCalls: stack.fuseki.queries - graphBefore,
        ownerCheckouts: stack.accessPool.checkouts - sqlBefore, elapsed, cost: result.cost };
      evidence.push(sample);
      console.log('Retained qualifier key cost', JSON.stringify(sample));
      expect(orderReads).toBe(0);
      expect(writes).toBe(0);
      expect(result.cost.pagesRead).toBe(pages);
      expect(pages).toBeLessThanOrEqual(12);
      expect(bytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
      expect(sample.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
      expect(elapsed).toBeLessThan(WORK_READ_COST.deadlineMs);
      expect(result).not.toHaveProperty('placementCount');
      expect(result).not.toHaveProperty('next');
      expect(result).not.toHaveProperty('count');
      expect(result).not.toHaveProperty('candidateCount');
      if (result.outcome === 'missing') expect(result.occurrences).toEqual([]);
      return result;
    };
    const measuredWrite = async <T>(label: string, operation: () => Promise<T>) => {
      pages = 0; bytes = 0; writes = 0; writeBytes = 0;
      measuring = true;
      let result: T;
      try { result = await operation(); }
      finally { measuring = false; }
      evidence.push({ label, pages, bytes, writes, writeBytes });
      expect(writes).toBeGreaterThan(0);
      expect(writes).toBeLessThanOrEqual(12);
      expect(pages).toBeLessThanOrEqual(24);
      return result;
    };
    const mutate = async (operations: readonly CompositionOperation[], label: string) => {
      pages = 0; bytes = 0; writes = 0; writeBytes = 0;
      measuring = true;
      let result: Awaited<ReturnType<typeof changeAdmittedComposition>>;
      try { result = await changeAdmittedComposition(stack.env, account, stack.access,
        requestFor(editor), { structure, expectedHead: head, actingSubject: editor.actor,
          idempotencyKey: randomUUID(), operations }); }
      finally { measuring = false; }
      expect(result.outcome).toBe('succeeded');
      head = result.revision!;
      evidence.push({ label, pages, bytes, writes, writeBytes, cost: result.cost });
      return result;
    };

    expect((await measured('current-hit', 'selected')).occurrences.map(record => record.occurrence))
      .toEqual(selected.occurrences);
    expect((await measured('exact-hit', 'selected', retained)).occurrences.map(record => record.occurrence))
      .toEqual(selected.occurrences);
    const initialMiss = await measured('current-miss', 'absent');
    expect(initialMiss.outcome).toBe('missing');
    expect((await measured('private-mount-public', 'private-mount')).outcome).toBe('missing');
    expect((await measured('private-mount-owner', 'private-mount', undefined, editor)).occurrences
      .map(record => record.occurrence)).toEqual(privateMount.occurrences);
    expect((await measured('private-mount-outsider', 'private-mount', undefined, outsider)).outcome).toBe('missing');
    await stack.accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2',
      [editor.actor, `semantic:read:${zone}`]);
    expect((await measured('private-mount-revoked-exact', 'private-mount', retained, editor)).outcome).toBe('missing');
    await editor.grant(`semantic:read:${zone}`, 'semantic.read');
    expect((await measured('private-target-public', 'private-target')).outcome).toBe('missing');
    expect((await measured('private-target-granted', 'private-target', undefined, editor)).occurrences
      .map(record => record.occurrence)).toEqual(restrictedMount.occurrences);
    await stack.accessPool.query('UPDATE access.permission_grant SET active=false WHERE recipient_subject=$1 AND scope_id=$2',
      [editor.actor, `semantic:read:${privateCollection}`]);
    expect((await measured('private-target-revoked-exact', 'private-target', retained, editor)).outcome).toBe('missing');

    // Include unqualified groups and unrelated mounted routes. Growing both
    // trees must leave an exact miss on one retained key-tree descent.
    let unrelated = 0;
    for (const size of [32, 320, 1024]) {
      while (unrelated < size) {
        const amount = Math.min(16, size - unrelated);
        await mutate(Array.from({ length: amount }, (_, index): CompositionOperation => ({ op: 'insert',
          parent: structure, position: 'last', ...(unrelated < 32 ? { role: 'group' } : { role: 'mount',
            target: collection, qualifier: { type: 'zone-mount', zone,
              routeSegment: `other-${unrelated + index}`, disclosure: 'public', key: 'id' } }),
        })), `prepare-${unrelated + amount}`);
        unrelated += amount;
      }
      const missing = await measured(`miss-${size}-unrelated`, 'absent');
      expect(missing.outcome).toBe('missing');

      expect(missing.occurrences).toEqual([]);
      expect((await measured(`hit-${size}-unrelated`, 'selected')).occurrences.map(record => record.occurrence))
        .toEqual(selected.occurrences);
      const header = (await readCompositionHeader(stack.env, structure))!;
      const manifest = JSON.parse(new TextDecoder().decode(await objects.get(header.manifest.slice(-64)))) as ManifestShape;
      expect(manifest.qualifierKeys?.root.count).toBe(size - 32 + 3);
      expect(missing.cost.pagesRead).toBeLessThanOrEqual(initialMiss.cost.pagesRead + manifest.qualifierKeys!.root.level);
      expect(manifest.records.count).toBe(size + 3);
      expect(manifest.qualifierKeys?.sourceRoot).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(performance.now() - prepared).toBeLessThan(600_000);
    await mutate([{ op: 'update', occurrence: selected.occurrences[0]!, qualifier: {
      type: 'zone-mount', zone, routeSegment: 'renamed', disclosure: 'public', key: 'id',
    } }], 'key-mutation');
    expect((await measured('mutation-current-old-miss', 'selected')).outcome).toBe('missing');
    expect((await measured('mutation-current-new-hit', 'renamed')).occurrences.map(record => record.occurrence))
      .toEqual(selected.occurrences);
    expect((await measured('mutation-exact-old-hit', 'selected', retained)).occurrences.map(record => record.occurrence))
      .toEqual(selected.occurrences);
    expect((await measured('mutation-exact-new-miss', 'renamed', retained)).outcome).toBe('missing');
    expect((await editor.send('POST', `${zonePath}/mounts`, { expectedHead: head, target: collection,
      routeSegment: 'renamed', disclosure: 'public', actingSubject: editor.actor })).status).toBe(409);
    const removed = await measuredWrite('remove-maintenance', async () => json<{ revision: string }>(await editor.send('DELETE',
      `${zonePath}/mounts/${short(selected.occurrences[0]!)}`, { expectedHead: head, actingSubject: editor.actor })));
    head = removed.revision;
    expect((await measured('removed-current-miss', 'renamed')).outcome).toBe('missing');
    await editor.grant(`semantic:read:${privateCollection}`, 'semantic.read');
    const restored = await measuredWrite('replacement-maintenance', async () => json<{ revision: string }>(await editor.send('POST',
      `/v1/compositions/${short(structure)}/restorations`, {
        expectedHead: head, restoredFrom: retained, actingSubject: editor.actor,
      })));
    head = restored.revision;
    expect((await measured('replacement-restored-hit', 'selected')).occurrences.map(record => record.occurrence))
      .toEqual(selected.occurrences);
    expect((await measured('replacement-restored-new-miss', 'renamed')).outcome).toBe('missing');

    const header = (await readCompositionHeader(stack.env, structure))!;
    const manifestDigest = header.manifest.slice(-64);
    const rootBytes = await objects.get(manifestDigest);
    const root = JSON.parse(new TextDecoder().decode(rootBytes)) as ManifestShape & { format: string; pageFormat: string };
    const keyDigest = root.qualifierKeys!.root.page.slice(-64);
    for (const failure of ['missing', 'corrupt'] as const) {
      override = async (digest, value) => {
        if (digest === keyDigest) throw failure === 'missing'
          ? new ObjectUnavailable('Fixture retained key page is unavailable')
          : new ObjectIntegrityError('Fixture retained key page digest differs');
        return value;
      };
      try { await expect(lookup('absent')).rejects.toBeInstanceOf(failure === 'missing'
        ? StructureObjectUnavailable : StructureObjectCorrupt); }
      finally { override = undefined; }
    }
    override = (digest, value) => digest === manifestDigest ? new TextEncoder().encode(JSON.stringify({
      ...root, qualifierKeys: { ...root.qualifierKeys, sourceRoot: `sha256:${'0'.repeat(64)}` },
    })) : value;
    try { await expect(lookup('absent')).rejects.toBeInstanceOf(StructureObjectCorrupt); }
    finally { override = undefined; }
    // Old immutable bytes stay ordinary-readable but carry no completeness
    // promise for a retained key lookup. Missing coverage cannot report EOF.
    const legacyRoot = { ...root };
    delete legacyRoot.qualifierKeys;
    override = (digest, value) => digest === manifestDigest ? new TextEncoder().encode(JSON.stringify({
      ...legacyRoot, format: 'rezics-structure-manifest-v1', pageFormat: 'rezics-structure-page-v1',
    })) : value;
    try {
      await expect(lookup('absent')).rejects.toBeInstanceOf(StructureObjectUnavailable);
      expect((await editor.read(zonePath)).status).toBe(200);
    } finally { override = undefined; }
    expect(await objects.get(manifestDigest)).toEqual(rootBytes);
    expect(await objects.get(retainedDigest)).toEqual(retainedBytes);
    // A fresh adapter and request retain no cached posting or source coverage.
    const reopened = stack.objects('semantic/structure/');
    await reopened.initialize();
    Object.assign(stack.env, { structureObjects: reopened });
    try {
      expect((await lookup('selected', retained)).occurrences.map(record => record.occurrence)).toEqual(selected.occurrences);
      expect((await lookup('absent', retained)).outcome).toBe('missing');
    } finally { Object.assign(stack.env, { structureObjects: counted }); }
    const source = (await stack.fuseki.query(`SELECT ?epoch ?sequence WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(retained)} <${RV}dataEpoch> ?epoch ; <${RV}sequence> ?sequence } }`)).results!.bindings[0]!;
    expect((await lookup('selected', retained)).sourcePosition).toEqual({ datasetId: 'product',
      dataEpoch: source.epoch!.value, sequence: source.sequence!.value });
    await Bun.write(resolve('.temp', 'goal', `composition-qualifier-key-costs-${Bun.env.REZICS_QA_RUN_ID}.json`),
      JSON.stringify({ runId: Bun.env.REZICS_QA_RUN_ID, costs: evidence }, null, 2));
  } finally {
    stack.fuseki.commandWithReceipt = originalCommand;
    await stack.stop();
  }
}, 600_000);
