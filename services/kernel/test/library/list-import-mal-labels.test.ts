import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { MAL_LABEL_LIMITS, malTagEvidence } from '../../src/library/list-import-mal-tags.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { createMalImport } from '../../src/library/list-import-mal.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { accountToken } from '../support/admitted-access.ts';
import { createKernelClient } from '@rezics/client';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type Capture } from '../support/growth.ts';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
const base = '/v1/libraryImports/mal';
function clientFor(fixture: NativeProfileFixture) {
  return createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      return fixture.sendWithHeaders('owner', request.method, url.pathname + url.search,
        request.body ? await request.json() : undefined, request.headers);
    }) as typeof fetch,
  });
}
const xml = (tags?: string, id = '1') =>
  `<myanimelist><anime><series_animedb_id>${id}</series_animedb_id><series_title>Display only</series_title><my_status>Completed</my_status>${tags === undefined ? '' : `<my_tags>${tags}</my_tags>`}<my_comments>private comment</my_comments><my_times_watched>9</my_times_watched></anime></myanimelist>`;
async function json(method: string, path: string, body?: unknown, status = 200, key = randomUUID(), persona = 'owner') {
  const response = await f.send(persona, method, path, body, key);
  const data = await response.json();
  expect({ status: response.status, data }).toMatchObject({ status });
  if (path.startsWith(base) && response.ok) expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  return data;
}
const upload = async (tags?: string) => (await json('POST', `${base}:preview`, { xml: xml(tags) })).id as string;
const label = async (name: string) =>
  (await json('POST', '/v1/libraryLabels', { name }, 201)).label as { id: string; revision: number };
const assignments = async (subject: string) =>
  (await json('GET', `/v1/libraryLabelAssignments?subjectId=${subject}&limit=100`)).assignments as {
    id: string;
    labelId: string;
    subjectId: string;
    revision: number;
  }[];
const selected = (value: number, l: { id: string; revision: number }) => ({
  value,
  target: { labelId: l.id, revision: l.revision },
});
async function review(id: string, target: string | null, labels: unknown[], row = 0) {
  const version = randomUUID();
  await json('POST', `${base}/${id}/review`, { row, target, labels, replace: false, skip: false }, 200, version);
  return version;
}
const apply = (id: string, version: string, row = 0, status = 200) =>
  json('POST', `${base}/${id}/apply`, { confirm: true, rows: [{ row, version, fields: ['tags'] }] }, status);

test('retained XML tag grammar preserves exact evidence and distinguishes absence, emptiness and unsupported input', () => {
  const evidence = (raw?: string) => malTagEvidence(parseMal(xml(raw))[0]!);
  expect(evidence().kind).toBe('missing');
  expect(evidence('').kind).toBe('empty');
  expect(evidence('  ').kind).toBe('unknown');
  expect(evidence('one,,two').kind).toBe('invalid');
  expect(evidence('one, &quot;two,three&quot;').kind).toBe('unsupported');
  expect(evidence('one\\,two').kind).toBe('unsupported');
  expect(evidence('one&#10;two').kind).toBe('invalid');
  expect(evidence('x'.repeat(MAL_LABEL_LIMITS.sourceBytes + 1)).reason).toBe('source-byte-limit');
  expect(evidence(Array.from({ length: 33 }, (_, i) => `v${i}`).join(',')).reason).toBe('source-value-limit');
  expect(evidence(' A &amp; B,second,A &amp; B').values).toEqual([
    { index: 0, raw: ' A & B', value: 'A & B', duplicateOf: null },
    { index: 1, raw: 'second', value: 'second', duplicateOf: null },
    { index: 2, raw: 'A & B', value: 'A & B', duplicateOf: 0 },
  ]);
  expect(evidence('unknown').values[0]?.value).toBe('unknown');
});

test('actual MAL upload adopts existing and new labels on its admitted Subject; retries preserve original native identities', async () => {
  const producer = await accountToken({
    accountId: f.steward.actor.accountId,
    clientId: f.steward.actor.clientId,
    scopes: [...f.steward.actor.scopes, 'subject:batch_write'],
  });
  const created = await json(
    'POST',
    '/v1/subjects:batchWrite',
    {
      commands: [
        {
          op: 'create',
          key: randomUUID(),
          source: {
            source: 'mal_anime',
            external_id: '1',
            record_revision: '1',
            digest: 'a'.repeat(64),
            converter_revision: 'fixture',
            field_group: 'facts',
          },
          subject: { type: 'ex:Child', labels: { en: 'Claim chooses identity' } },
        },
      ],
    },
    200,
    randomUUID(),
    producer,
  );
  const subject = created.results[0].value.id,
    existing = await label('Owned MAL target');
  const id = await upload('old,new,old,invalid,collision');
  const selection = [
    selected(0, existing),
    { value: 1, target: { name: '  MAL   Cafe\u0301  ' } },
    selected(2, existing),
    { value: 3, target: { name: ' '.repeat(2) } },
    { value: 4, target: { name: ' Owned MAL target ' } },
  ];
  const client = clientFor(f), retained = client.libraryImports.mal({ id }), version = randomUUID();
  expect((await retained.review.post({ row: 0, target: null, labels: selection, replace: false, skip: false },
    { headers: { 'idempotency-key': JSON.stringify(version) } })).status).toBe(200);
  const reopened = await retained.get();
  expect(reopened.data?.labelLimits).toEqual(MAL_LABEL_LIMITS);
  expect(reopened.data?.rows[0]?.tagEvidence).toMatchObject({ kind: 'supported', raw: 'old,new,old,invalid,collision' });
  expect(reopened.data?.rows[0]?.review?.labels?.selections[1]?.status).toBe('ready');
  const page = await json('GET', `${base}/${id}`);
  expect(page.rows[0].review).toMatchObject({
    target: subject,
    labels: {
      selections: [
        { status: 'ready' },
        { status: 'ready', target: { name: 'MAL Café' } },
        { status: 'duplicate' },
        { status: 'invalid' },
        { status: 'collision' },
      ],
    },
  });
  expect(page.rows[0].notes.value).toBe('private comment');
  expect(page.rows[0].repeats.value).toBe(9);
  const confirmation = await retained.apply.post({ confirm: true, rows: [{ row: 0, version, fields: ['tags'] }] });
  expect(confirmation.status).toBe(200);
  const result = confirmation.data!,
    adopted = result.outcomes[0]!.labels!;
  expect(adopted).toBeDefined();
  const assigned = await client.libraryLabelAssignments.get({ query: { subjectId: subject, limit: 100 } });
  expect(assigned.data?.assignments.find((a) => a.labelId === adopted![1]!.labelId)).toMatchObject(adopted![1]!.assignment!);
  expect(adopted.map((o: { status: string }) => o.status)).toEqual([
    'accepted',
    'accepted',
    'unchanged',
    'unsupported',
    'unsupported',
  ]);
  const native = await assignments(subject);
  expect(native.map((a) => a.labelId).sort()).toEqual([existing.id, adopted[1].labelId].sort());
  expect(native.find((a) => a.labelId === adopted[1].labelId)?.id).toBe(adopted[1].assignment.id);
  await json('GET', `/v1/libraryEntries/${subject}`, undefined, 404);
  expect((await json('GET', '/v1/libraryLabels?limit=100')).labels).toContainEqual({
    id: adopted[1].labelId,
    name: 'MAL Café',
    revision: 1,
  });
  // Both native commands committed; acknowledgement of their operands/outcome was lost.
  await f.pool.query(
    `UPDATE library.list_import_mal SET document=document
    #- '{labelIntents,0,items,1,label}' #- '{labelIntents,0,items,1,outcome}' WHERE account_id=$1 AND id=$2`,
    [f.owner.actor.accountId, id],
  );
  expect((await apply(id, version)).outcomes[0].labels).toEqual(adopted);
  expect(await assignments(subject)).toEqual(native);
  await json('GET', `${base}/${id}`, undefined, 404, randomUUID(), 'other');
  await json(
    'POST',
    `${base}/${id}/apply`,
    { confirm: true, rows: [{ row: 0, version, fields: ['tags'] }] },
    404,
    randomUUID(),
    'other',
  );
  await json('DELETE', `/v1/libraryLabels/${existing.id}?revision=1`);
  const replacement = await label('Owned MAL target');
  expect(replacement.id).not.toBe(existing.id);
  expect((await apply(id, version)).outcomes[0].labels[0].status).toBe('stale');
  expect((await assignments(subject)).some((a) => a.labelId === replacement.id)).toBe(false);
  await review(id, subject, [{ value: 0, target: { name: 'Reviewed replacement' } }]);
  await apply(id, version, 0, 409);
  await json(
    'POST',
    `${base}/${id}/review`,
    { row: 0, target: null, labels: selection, replace: false, skip: false },
    409,
    version,
  );
  await json('DELETE', `${base}/${id}`);
  expect((await assignments(subject)).some((a) => a.labelId === adopted[1].labelId)).toBe(true);
}, 120000);

test('explicit canonical manual review changes the Subject and retires the previous label confirmation', async () => {
  const first = await f.createSubject('unprofiled', 'Same tag text'),
    chosen = await f.createSubject('unprofiled', 'Same tag text'), target = await label('Same tag text');
  const id = await upload('Same tag text'), old = await review(id, first, [selected(0, target)]);
  const version = await review(id, chosen, [selected(0, target)]);
  await apply(id, old, 0, 409);
  expect(await assignments(first)).toEqual([]);
  const result = (await apply(id, version)).outcomes[0].labels[0];
  expect(result.status).toBe('accepted');
  expect(await assignments(chosen)).toEqual([{ ...result.assignment, labelId: target.id, subjectId: chosen }]);
  expect((await json('GET', `${base}/${id}`)).rows[0].review).toMatchObject({ target: chosen, binding: null });
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('32 native reservations refuse extra assignment and deleted parents can be reclaimed by the original command', async () => {
  const subject = await f.createSubject('unprofiled'),
    targets = [];
  for (let n = 0; n < 32; n++) {
    const l = await label(`MAL capacity ${n}`);
    targets.push(l);
    await json('POST', `/v1/libraryLabels/${l.id}:assign`, { subjectId: subject });
  }
  const id = await upload(Array.from({ length: 32 }, (_, i) => `value ${i}`).join(','));
  const full = await review(
    id,
    subject,
    targets.map((l, i) => selected(i, l)),
  );
  expect((await apply(id, full)).outcomes[0].labels.map((o: { status: string }) => o.status)).toEqual(
    Array(32).fill('unchanged'),
  );
  const version = await review(id, subject, [
    { value: 31, target: { name: 'MAL capacity overflow' } },
    selected(0, targets[0]!),
  ]);
  const refused = (await apply(id, version)).outcomes[0].labels;
  expect(refused[0]).toMatchObject({ status: 'failed', reason: 'library-label-capacity' });
  expect(refused[1].status).toBe('unchanged');
  expect(await assignments(subject)).toHaveLength(32);
  await json('DELETE', `/v1/libraryLabels/${targets[1]!.id}?revision=1`);
  const retry = (await apply(id, version)).outcomes[0].labels;
  expect(retry[0]).toMatchObject({ status: 'accepted', labelId: refused[0].labelId });
  expect(await assignments(subject)).toHaveLength(32);
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('negative retained evidence and first/deep/final pages stay inert; altered exact source stales confirmation', async () => {
  const subject = await f.createSubject('unprofiled');
  const rows = Array.from({ length: 41 }, (_, i) =>
    xml(i === 0 ? '' : i === 20 ? 'a,\"b,c\"' : 'one', String(1000 + i))
      .replace('<myanimelist>', '')
      .replace('</myanimelist>', ''),
  ).join('');
  const id = (await json('POST', `${base}:preview`, { xml: `<myanimelist>${rows}</myanimelist>` })).id;
  for (const [after, length, kind] of [
    [0, 20, 'empty'],
    [20, 20, 'unsupported'],
    [40, 1, 'supported'],
  ] as const) {
    const page = await json('GET', `${base}/${id}?after=${after}`);
    expect(page.rows).toHaveLength(length);
    expect(page.rows[0].tagEvidence.kind).toBe(kind);
  }
  const empty = await review(id, subject, [{ value: 0, target: { name: 'Do not invent empty tag' } }]);
  expect((await apply(id, empty)).outcomes[0].labels[0].status).toBe('unsupported');
  const unsupported = await review(id, subject, [{ value: 0, target: { name: 'Do not split quoted field' } }], 20);
  expect((await apply(id, unsupported, 20)).outcomes[0].labels[0].status).toBe('unsupported');
  const version = await review(id, subject, [{ value: 0, target: { name: 'Exact source binding' } }], 40);
  await f.pool.query(
    `UPDATE library.list_import_mal SET document=jsonb_set(document,'{rows,40,fields,my_tags}','"changed"')
    WHERE account_id=$1 AND id=$2`,
    [f.owner.actor.accountId, id],
  );
  expect((await apply(id, version, 40)).outcomes[0].labels[0].status).toBe('stale');
  expect(await assignments(subject)).toEqual([]);
  await json('DELETE', `${base}/${id}`);
}, 120000);

test('partial request cancellation preserves accepted assignments; expiry and removal only retire evidence', async () => {
  const subject = await f.createSubject('unprofiled'),
    a = await label('MAL partial A'),
    b = await label('MAL partial B');
  const id = await upload('first,second'),
    version = await review(id, subject, [selected(0, a), selected(1, b)]);
  const service = createMalImport({ pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() });
  const cancel = new AbortController();
  const result = await service.apply(
    f.owner.actor,
    id,
    { confirm: true, rows: [{ row: 0, version, fields: ['tags'] }] },
    Date.now() + 30000,
    cancel.signal,
    () => cancel.abort(),
  );
  expect(result).toMatchObject({
    stopped: true,
    remaining: [0],
    outcomes: [{ labels: [{ status: 'accepted', labelId: a.id }], remainingLabels: [1] }],
  });
  expect((await assignments(subject)).map((v) => v.labelId)).toEqual([a.id]);
  await json('POST', `${base}/${id}/cancel`, {});
  await apply(id, version, 0, 409);
  await f.pool.query(
    "UPDATE library.list_import_mal SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND id=$2",
    [f.owner.actor.accountId, id],
  );
  await json('GET', `${base}/${id}`, undefined, 404);
  const fresh = await upload('third');
  expect(
    (
      await f.pool.query('SELECT 1 FROM library.list_import_mal WHERE account_id=$1 AND id=$2', [
        f.owner.actor.accountId,
        id,
      ])
    ).rows,
  ).toEqual([]);
  expect((await assignments(subject)).map((v) => v.labelId)).toEqual([a.id]);
  await json('DELETE', `${base}/${fresh}`);
}, 120000);

test('whole retained MAL caller at native64/512/4096 charges documents, preparation and nested native writes', async () => {
  const db = await openGrowthDatabase();
  let g: NativeProfileFixture | undefined;
  try {
    g = await createProfileEntryFixture({ pool: db.pool, projectLinks: false });
    const fixture = g, client = clientFor(fixture), route = routeOf(fixture.owner.actor.accountId)!;
    async function call(method: string, path: string, body?: unknown, status = 200) {
      const response = await fixture.send('owner', method, path, body);
      const data = await response.json();
      expect({ status: response.status, data }).toMatchObject({ status });
      if (path.startsWith(base) && response.ok) expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      return data;
    }
    const parents: { id: string; revision: number }[] = [];
    for (let i = 0; i < 31; i++) parents.push((await call('POST', '/v1/libraryLabels', { name: `Growth MAL ${i}` }, 201)).label);
    const historySubject = await fixture.createSubject('unprofiled');
    const historyAssignment = (await call('POST', `/v1/libraryLabels/${parents[0]!.id}:assign`, { subjectId: historySubject })).assignment;
    await call('POST', `/v1/libraryLabels/${parents[0]!.id}:unassign`, {
      subjectId: historySubject, assignmentId: historyAssignment.id, revision: historyAssignment.revision,
    });
    const template = (await db.admin.query('SELECT * FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [route, fixture.owner.actor.accountId, parents[0]!.id])).rows[0]!;
    const inactive = (await db.admin.query('SELECT * FROM library.label_assignment WHERE route=$1 AND assignment_id=$2',
      [route, historyAssignment.id])).rows[0]!;
    const neighbour = fixture.other.actor, otherRoute = routeOf(neighbour.accountId)!;
    const raw = Array.from({ length: 32 }, (_, i) => `v${String(i).padStart(2, '0')}`).join(',');
    const tags = 'x'.repeat(MAL_LABEL_LIMITS.sourceBytes - Buffer.byteLength(raw)) + raw;
    const source = `<myanimelist>${Array.from({ length: 41 }, (_, i) => xml(i === 20 ? 'a,&quot;b,c&quot;' : i === 0 || i === 40 ? tags : 'one', String(10000 + i))
      .replace('<myanimelist>', '').replace('</myanimelist>', '')).join('')}</myanimelist>`;
    expect(Buffer.byteLength(tags)).toBe(MAL_LABEL_LIMITS.sourceBytes);
    const sourceBytes = Buffer.byteLength(source), evidence: unknown[] = [];
    let subject = '', iteration = 0;
    async function prepare() {
      subject = historySubject;
      // One unrelated live reservation makes thirty existing targets + one new name fill all 32 slots.
      await call('POST', `/v1/libraryLabels/${parents[30]!.id}:assign`, { subjectId: subject });
    }
    async function operation() {
      const suffix = String(iteration++).padStart(6, '0');
      const id = (await call('POST', `${base}:preview`, { xml: source })).id as string;
      const retained = client.libraryImports.mal({ id });
      let pageBytes = 0;
      for (const [after, length, kind] of [[0, 20, 'supported'], [20, 20, 'unsupported'], [40, 1, 'supported']] as const) {
        const page = await retained.get({ query: { after } });
        expect(page.status).toBe(200);
        expect(page.data?.rows).toHaveLength(length);
        expect(page.data?.rows[0]?.tagEvidence.kind).toBe(kind);
        expect(page.data?.next).toBe(after === 40 ? null : after + 20);
        pageBytes += Buffer.byteLength(JSON.stringify(page.data));
      }
      expect((await retained.source.get()).data?.xml).toBe(source);
      const rows = [], selections = [];
      for (const row of [0, 20, 40]) {
        const labels = row === 20 ? [{ value: 0, target: { name: `Negative ${suffix}` } }] : [
          ...parents.slice(0, 30).map((p, value) => selected(value, p)),
          { value: 30, target: { name: `New ${row === 0 ? 'A' : 'B'} ${suffix}` } }, selected(31, parents[0]!),
        ];
        selections.push(labels);
        const version = randomUUID();
        expect((await retained.review.post({ row, target: subject, labels, skip: false, replace: false },
          { headers: { 'idempotency-key': JSON.stringify(version) } })).status).toBe(200);
        rows.push({ row, version, fields: ['tags'] });
      }
      const confirmed = await retained.apply.post({ confirm: true, rows });
      expect(confirmed.status).toBe(200);
      const outcomes = confirmed.data!.outcomes;
      expect(outcomes[0]!.labels!.map((v) => v.status)).toEqual([...Array(31).fill('accepted'), 'unchanged']);
      expect(outcomes[1]!.labels).toMatchObject([{ status: 'unsupported' }]);
      expect(outcomes[2]!.labels![30]).toMatchObject({ status: 'failed', reason: 'library-label-capacity' });
      expect(outcomes[2]!.labels!.filter((v) => v.status === 'unchanged')).toHaveLength(31);
      const native = await client.libraryLabelAssignments.get({ query: { subjectId: subject, limit: 100 } });
      expect(native.data?.assignments).toHaveLength(32);
      for (const outcome of outcomes[0]!.labels!)
        expect(native.data?.assignments.find((a) => a.labelId === outcome.labelId)).toMatchObject(outcome.assignment!);
      // Original native keys must recover both creation and assignment after losing the producer acknowledgement.
      await db.pool.query(`UPDATE library.list_import_mal SET document=document
        #- '{labelIntents,0,items,30,label}' #- '{labelIntents,0,items,30,outcome}' WHERE route=$1 AND account_id=$2 AND id=$3`,
        [route, fixture.owner.actor.accountId, id]);
      const replay = await retained.apply.post({ confirm: true, rows });
      expect(replay.status).toBe(200);
      expect(replay.data!.outcomes).toEqual(outcomes);
      const version = randomUUID();
      expect((await retained.review.post({ row: 0, target: subject, labels: selections[0]!, skip: false, replace: false },
        { headers: { 'idempotency-key': JSON.stringify(version) } })).status).toBe(200);
      expect((await retained.apply.post({ confirm: true, rows: [rows[0]!] })).status).toBe(409);
      expect((await retained.cancel.post({}, { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } })).status).toBe(200);
      expect((await retained.apply.post({ confirm: true, rows: [{ ...rows[0]!, version }] })).status).toBe(409);
      expect((await retained.delete(undefined, { headers: { 'idempotency-key': JSON.stringify(randomUUID()) } })).status).toBe(200);
      expect((await retained.get()).status).toBe(404);
      expect((await client.libraryLabelAssignments.get({ query: { subjectId: subject, limit: 100 } })).data?.assignments).toEqual(native.data!.assignments);
      for (const assignment of native.data!.assignments.filter((a) => a.labelId !== parents[30]!.id))
        await call('POST', `/v1/libraryLabels/${assignment.labelId}:unassign`, {
          subjectId: subject, assignmentId: assignment.id, revision: assignment.revision,
        });
      const outputBytes = Buffer.byteLength(JSON.stringify(outcomes.flatMap((o) => o.labels ?? [])));
      expect(outputBytes).toBeLessThanOrEqual(MAL_LABEL_LIMITS.outputBytes);
      return { sourceBytes, pageBytes, selectionBytes: Buffer.byteLength(JSON.stringify(selections)), outputBytes };
    }
    function nodes(value: unknown): Record<string, unknown>[] {
      if (!value || typeof value !== 'object') return [];
      return [...('Node Type' in value ? [value as Record<string, unknown>] : []), ...Object.values(value).flatMap(nodes)];
    }
    function observe(raw: Capture) {
      const plans = raw.plans.flatMap(nodes);
      const reservations = plans.filter((n) => n['Index Name'] === 'label_assignment_reserved_source');
      expect(reservations.length).toBeGreaterThan(0);
      for (const n of reservations) expect((Number(n['Actual Rows']) + Number(n['Rows Removed by Filter'] ?? 0)) * Number(n['Actual Loops'])).toBeLessThanOrEqual(32);
      const matching = (pattern: RegExp) => raw.statements.flatMap((text, index) => pattern.test(text) ? [index] : []);
      const loads = matching(/SELECT document FROM library\.list_import_mal/i), writes = matching(/UPDATE library\.list_import_mal SET document=\$4/i);
      expect(loads.length).toBeGreaterThan(64);
      expect(writes.length).toBeGreaterThan(64);
      const bytes = (indices: number[], values: readonly number[] | undefined) => {
        expect(values).toBeDefined();
        return indices.reduce((sum, i) => sum + values![i]!, 0);
      };
      const documentReadBytes = bytes(loads, raw.responseBytes), documentWriteBytes = bytes(writes, raw.requestBytes);
      expect(documentReadBytes).toBeGreaterThan(sourceBytes);
      expect(documentWriteBytes).toBeGreaterThan(sourceBytes);
      // Retain complete plans, including owner/Subject preparation, receipts, History/events and owner indices.
      return { documentLoads: loads.length, documentWrites: writes.length, documentReadBytes, documentWriteBytes, capture: raw };
    }
    const report = await checkGrowth(db, {
      name: 'retained MAL whole caller, fixed R=3 T=32 M=2 P=20 and encoded source',
      scales: [64, 512, 4096], bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      counted: { read: (value) => value as Awaited<ReturnType<typeof operation>>,
        bounds: { sourceBytes: 'constant', pageBytes: 'constant', selectionBytes: 'constant', outputBytes: 'constant' } },
      async grow(database, scale, previous) {
        await seed(database, { name: 'MAL native owner catalogue and retained same-Subject assignments', hotPartition: partitionOf(route), hotShare: 1,
          rows(p) {
            const id = newId(route), otherId = newId(otherRoute), s = newId(routeOf(historySubject)!);
            return {
              'library.personal_label': [
                { ...template, label_id: id, normalized_name: `Unrelated MAL ${p.ordinal}` },
                { ...template, route: otherRoute, account_id: neighbour.accountId, label_id: otherId, normalized_name: `Neighbour MAL ${p.ordinal}` },
              ],
              'library.label_assignment': [
                { ...inactive, assignment_id: newId(route), label_id: id },
                { ...inactive, assignment_id: newId(route), subject_id: s, label_id: parents[0]!.id },
                { ...inactive, route: otherRoute, account_id: neighbour.accountId, assignment_id: newId(otherRoute), label_id: otherId, subject_id: s },
              ],
            };
          },
        }, { from: previous, to: scale });
      },
      prepare,
      async warmup(_database, scale) {
        await prepare();
        const measured = await capture(db, operation);
        evidence.push({ scale, ...measured.value, ...observe(measured.capture) });
      },
      operation,
    });
    console.info(JSON.stringify({ report, evidence }));
  } finally {
    await g?.close();
    await db.close();
  }
}, 1800000);
