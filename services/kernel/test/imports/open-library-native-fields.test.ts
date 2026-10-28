import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { converter_revision } from '../../../../packages/conversion/src/open-library.ts';
import type { Dump, Proposal } from '../../../../specs/imports-api-driver.ts';
import type { Subject } from '../../../../specs/semantic-driver.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { processImage } from '../../src/content/image-job.ts';
import { processImportedMedia } from '../../src/content/media-import-job.ts';
import { openApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';
import { identitySupport } from './identity-fixture.ts';

type NativeRecord = {
  type: { key: string };
  key: string;
  revision: number;
  last_modified: { value: string };
  title: string;
  authors?: unknown[];
  works?: { key: string }[];
  covers?: number[];
  isbn_10?: string[];
  isbn_13?: string[];
  description?: { value: string };
  notes?: { value: string };
};
const fixture = (name: string): Promise<NativeRecord> =>
  Bun.file(new URL(`../../../../specs/fixtures/imports/open-library/${name}.json`, import.meta.url)).json();
function dump(records: NativeRecord[]): Dump {
  return {
    source: 'openlibrary',
    snapshot: 'fixture-label-only',
    converterRevision: converter_revision,
    bytes: new TextEncoder().encode(
      records
        .map((r) => [r.type.key, r.key, r.revision, r.last_modified.value, JSON.stringify(r)].join('\t'))
        .join('\n') + '\n',
    ),
  };
}
const field = (proposals: Proposal[], property: string) =>
  proposals.filter((p) => p.statement?.property.id === property);
const content = (p: Proposal) => p.statement!.value.content;
const calendar = 'http://www.wikidata.org/entity/Q1985727';
const date = (time: string, precision: number) => ({ time, precision, calendarmodel: calendar });

test('Open Library native book edition ISBN rights and cover fields survive real API selection and storage', async () => {
  // Keep the importer's fixed SQLite journal on the check host's tmpfs.
  const previousTemporaryDirectory = process.env.TMPDIR;
  const runtime = await (async () => {
    process.env.TMPDIR = '/dev/shm';
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
    } finally {
      if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTemporaryDirectory;
    }
  })();
  try {
    // This fixed editorial session exceeds the new-account 30-write budget.
    // Provision a trusted editor through governance, retaining native limits.
    const tierKey = randomUUID();
    const editorTier = await runtime.request(
      `/v1/accounts/${runtime.identity.governance.accountId}:setRateTier`,
      { key: tierKey, tier: 'trusted' },
      identitySupport(runtime.identity).managementBearer,
      tierKey,
    );
    expect(editorTier.status, await editorTier.text()).toBe(200);
    const observer = await openApiObserver(runtime);
    const work = await fixture('work'),
      edition = await fixture('edition');
    // Crossed source presence proves neither direction copies authors automatically.
    const noAuthorWork = { ...work, key: '/works/OL900000003W', authors: [], covers: [] };
    const noAuthorEdition = { ...edition, key: '/books/OL900000004M', authors: [] };
    // This edition has no ISBN-13 input: its public fact must come from ISBN-10.
    noAuthorEdition.isbn_13 = [];
    edition.works = [{ key: noAuthorWork.key }];
    work.isbn_10 = ['0306406152'];
    work.isbn_13 = ['9780306406157'];
    edition.isbn_10 = ['0-306-40615-2', '0306406152'];
    edition.isbn_13 = ['978-0-306-40615-7', '9780306406157'];
    const records = [work, noAuthorWork, edition, noAuthorEdition];
    const input = dump(records);
    // Register source HTTP bytes before the real import job can request them.
    const sourceUrl = 'https://covers.openlibrary.org/b/id/900000001-L.jpg';
    const source = await runtime.mediaBoundary.source(sourceUrl);
    const run = await runtime.run(input);
    expect(run.outcome).toBe('complete');
    expect(run.exchanges.length).toBeGreaterThan(0);
    expect(run.conversions).toContainEqual(
      expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          bibliographyPermission: 'CC0-1.0',
          description: { text: work.description!.value, license: 'LicenseRef-unknown', field_group: 'summary' },
        }),
      }),
    );
    const commands = run.exchanges.flatMap(
      (e) => (e.request.body as { commands: { key: string; op: string }[] }).commands,
    );
    for (const exchange of run.exchanges) {
      expect(new URL(exchange.request.url).pathname).toBe('/v1/subjects:batchWrite');
      expect(exchange.response.status).toBe(200);
      expect(exchange.request.headers.get('authorization')).toStartWith('Bearer ');
    }
    for (const command of commands) expect(await runtime.receipt(command.key)).toBeString();
    expect(commands.filter((c) => c.op === 'create')).toHaveLength(4);
    for (const command of commands) {
      expect(command).not.toHaveProperty('rights');
      const serialized = JSON.stringify(command);
      for (const forbidden of [
        work.description!.value,
        edition.notes!.value,
        'PRIVATE_TEXT_SENTINEL',
        'USER_POST_SENTINEL',
        'ACCOUNT_SENTINEL',
      ])
        expect(serialized).not.toContain(forbidden);
    }
    expect(runtime.captures.some((c) => new URL(c.request.url).pathname.startsWith('/v1/documents'))).toBe(false);
    const views = [];
    for (const record of records) views.push(await observer.read('openlibrary', record.key));
    const ids = views.map((v) => v.subject!.id);
    expect(new Set(ids).size).toBe(4);
    for (const [i, view] of views.entries()) {
      const record = records[i]!;
      expect(view.subject!.type).toBe(i < 2 ? 'schema:Book' : 'bf:Instance');
      expect(field(view.proposals, 'wdt:P648').map(content)).toEqual([record.key.split('/').at(-1)!]);
      expect(view.responses.every((r) => r.status === 200)).toBe(true);
      for (const proposal of view.proposals) {
        expect(proposal.subjectId).toBe(ids[i]!);
        expect(proposal.recordRevision).toBe(String(record.revision));
        expect(proposal.recordDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(proposal.converterRevision).toBe(converter_revision);
        expect(view.revisions.some((r) => r.proposalIds.includes(proposal.id))).toBe(true);
        const parts = proposal.references.flatMap((r) => r.parts);
        for (const [property, value] of [
          ['schema:url', `https://openlibrary.org${record.key}`],
          ['wdt:P648', record.key.split('/').at(-1)!],
          ['schema:version', String(record.revision)],
          ['schema:dateModified', date(`+${record.last_modified.value.slice(0, 10)}T00:00:00Z`, 11)],
        ] as const)
          expect(
            parts.some((p) => p.property.id === property && JSON.stringify(p.value.content) === JSON.stringify(value)),
          ).toBe(true);
      }
      expect(field(view.proposals, 'schema:abstract')).toEqual([]);
      // Observe native summary storage at these exact subject routes: there is no document to disclose.
      const documents = await runtime.database.admin.query(
        'SELECT id FROM content.imported_field WHERE route=$1 AND subject=$2 LIMIT 1',
        [routeOf(ids[i]!), ids[i]!],
      );
      expect(documents.rows).toEqual([]);
    }
    for (const view of views.slice(0, 2)) expect(field(view.proposals, 'schema:isbn')).toEqual([]);
    for (const view of views.slice(2)) {
      expect(field(view.proposals, 'schema:isbn').map(content)).toEqual(['9780306406157']);
      expect(field(view.proposals, 'schema:datePublished').map(content)).toEqual([date('+1980-05-00T00:00:00Z', 10)]);
    }
    for (const i of [1, 3]) expect(field(views[i]!.proposals, 'schema:author')).toEqual([]);
    for (const i of [0, 2]) {
      const authors = field(views[i]!.proposals, 'schema:author');
      expect(authors).toHaveLength(1);
      expect(authors[0]!.statement!.value as unknown).toEqual({ type: 'somevalue' });
      expect(authors[0]!.statement!.qualifiers).toContainEqual(
        expect.objectContaining({
          property: expect.objectContaining({ id: 'wdt:P648' }),
          value: { type: 'value', content: 'OL900000001A' },
        }),
      );
    }
    // This runtime has no identifierLookup adapter. Even a known imported work uses
    // the documented unresolved representation, not a guessed resolution endpoint.
    for (const i of [2, 3]) {
      const relations = field(views[i]!.proposals, 'schema:exampleOfWork');
      expect(relations).toHaveLength(1);
      expect(relations[0]!.statement!.value as unknown).toEqual({ type: 'somevalue' });
      expect(relations[0]!.statement!.qualifiers).toContainEqual(
        expect.objectContaining({
          property: expect.objectContaining({ id: 'wdt:P648' }),
          value: { type: 'value', content: records[i]!.works![0]!.key.split('/').at(-1)! },
        }),
      );
    }
    const cover = field(views[0]!.proposals, 'schema:image');
    expect(cover).toHaveLength(1);
    const mediaId = String(content(cover[0]!));
    expect(mediaId).toMatch(/^[a-f0-9-]{36}$/);
    const native = await runtime.mediaBoundary.observe(mediaId);
    expect(native.row).toMatchObject({
      id: mediaId,
      containerId: ids[0],
      state: 'available',
      purpose: 'cover',
      sourceUrl,
    });
    expect(native.row.credit).toEqual({
      rightsHolder: '(c) rights holder',
      via: { name: 'Open Library', url: `https://openlibrary.org${work.key}` },
      license: 'LicenseRef-unknown',
      obligations: [],
    });
    expect(native.row.provenance).toMatchObject({
      source: 'openlibrary',
      external_id: work.key,
      field_group: 'cover',
      record_revision: '7',
    });
    expect(native.row.provenance.references.flatMap((r) => r.parts).map((p) => [p.property.id, p.value])).toEqual(
      cover[0]!.references.flatMap((r) => r.parts).map((p) => [p.property.id, p.value]),
    );
    expect(native.transitions).toContain('available');
    expect(native.variants.length).toBeGreaterThan(0);
    for (const variant of native.variants) {
      expect(variant.bytes.length).toBeGreaterThan(0);
      expect(Buffer.from(variant.bytes).equals(Buffer.from(source.bytes))).toBe(false);
    }
    const trace = await runtime.mediaBoundary.capture();
    expect(trace.registrations.some((r) => r.handler === processImportedMedia)).toBe(true);
    expect(trace.registrations.some((r) => r.handler === processImage)).toBe(true);
    expect(trace.executedJobs).toBeGreaterThan(0);
    expect(trace.sourceRequests.map((r) => r.url)).toContain(sourceUrl);
    expect(trace.liveInternetRequests).toEqual([]);
    const mediaRequests = runtime.captures.filter((c) => new URL(c.request.url).pathname === '/v1/media:importFromUrl');
    expect(mediaRequests).toHaveLength(1);
    const captured = mediaRequests[0]!;
    expect(JSON.parse(captured.body)).toMatchObject({ containerId: ids[0], sourceUrl, credit: native.row.credit });
    const actor = await runtime.identity.access.authenticate(captured.request.headers.get('authorization')!.slice(7), {
      pool: runtime.database.pool,
      deadline: Date.now() + 10000,
    });
    expect(actor.kind).toBe('account');
    expect(actor.accountId).toBe(runtime.identity.bulk.accountId);
    expect(native.row.uploaderId).toBe(actor.accountId);
    expect(captured.request.headers.has('cookie')).toBe(false);

    // Select actual returned candidate IDs through the ordinary editor API in
    // Global, which is also the public page's projection context.
    const grant = await observer.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.governance.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const links = linkProjection(runtime.database.pool);
    for (const view of views) {
      const groups = new Map<string, Proposal[]>();
      for (const proposal of view.proposals) {
        const property = proposal.statement!.property.id;
        groups.set(property, [...(groups.get(property) ?? []), proposal]);
        const accepted = await observer.http(`/v1/subjects/${proposal.subjectId}/candidates/${proposal.id}:accept`, {
          context: GLOBAL_CONTEXT,
          expected_head: null,
        });
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      }
      for (const [property, proposals] of groups) {
        const adopted = await observer.http(`/v1/subjects/${view.subject!.id}:adopt`, {
          context: GLOBAL_CONTEXT,
          property,
          mode: 'replace',
          expected_head: null,
          selection: proposals.map((p) => ({ candidate: p.id, rank: 'normal' })),
        });
        expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
      }
      // The fixture's worker delivers media jobs; deliver the actual semantic
      // relay too so the public relation preview observes the editor's writes.
      let caughtUp = false;
      for (let batch = 0; batch < 16; batch++) {
        const delivered = await links.run(partitionOf(routeOf(view.subject!.id)!));
        expect(delivered.status).not.toBe('stopped');
        expect(delivered.status).not.toBe('busy');
        if (delivered.status === 'read' && delivered.envelopes === 0) {
          caughtUp = true;
          break;
        }
      }
      expect(caughtUp).toBe(true);
      const publicSubject = await runtime.request(`/v1/subjects/${view.subject!.id}`);
      expect(publicSubject.status).toBe(200);
      const body = (await publicSubject.json()) as { subject: Subject };
      for (const [property, proposals] of groups)
        expect(body.subject.statements[property]!.map((s) => s.id).sort()).toEqual(proposals.map((p) => p.id).sort());
      const page = await runtime.request('/v1/pages:read', { target: { subject: view.subject!.id } });
      expect(page.status).toBe(200);
      const publicPage = (await page.json()) as {
        subject: string;
        reads: Record<string, { status: number; body: { subject?: Subject } }>;
      };
      expect(publicPage.subject).toBe(view.subject!.id);
      const embedded = Object.values(publicPage.reads).find((r) => r.body.subject?.id === view.subject!.id);
      expect(embedded?.status).toBe(200);
      expect(embedded?.body.subject?.statements).toEqual(body.subject.statements);
      const publicBytes = JSON.stringify([view.responses.map((r) => r.body), body, publicPage]);
      for (const forbidden of [
        work.description!.value,
        edition.notes!.value,
        'PRIVATE_TEXT_SENTINEL',
        'USER_POST_SENTINEL',
        'ACCOUNT_SENTINEL',
      ])
        expect(publicBytes).not.toContain(forbidden);
    }
    const disclosed = await observer.disclose(cover[0]!);
    expect(disclosed.status).toBe(200);
    expect(disclosed.bytes.length).toBeGreaterThan(0);
    expect(native.variants.some((v) => Buffer.from(v.bytes).equals(Buffer.from(disclosed.bytes)))).toBe(true);
    const effects = await observer.effects();
    expect(effects.subjects).toBe(4); // No fabricated author Person.
    const before = await runtime.mediaBoundary.capture();
    await runtime.restart();
    const repeated = await runtime.run(input);
    expect(repeated.outcome).toBe('complete');
    expect(repeated.exchanges).toEqual([]);
    expect(await observer.effects()).toEqual(effects);
    expect((await runtime.mediaBoundary.capture()).executedJobs).toBe(before.executedJobs);
    expect(runtime.captures.filter((c) => new URL(c.request.url).pathname === '/v1/media:importFromUrl')).toHaveLength(
      1,
    );
    for (const [i, record] of records.entries()) {
      const repeatedView = await observer.read('openlibrary', record.key);
      expect(repeatedView.subject!.id).toBe(ids[i]!);
      expect(repeatedView.proposals.map((p) => p.id).sort()).toEqual(views[i]!.proposals.map((p) => p.id).sort());
    }
    // A checksum-invalid native ISBN cannot enter public facts or advance effects.
    for (const invalid of [
      { ...edition, revision: 12, isbn_10: ['0306406153'] },
      { ...edition, revision: 13, isbn_13: ['9780306406158'] },
    ]) {
      const rejected = await runtime.run(dump([work, noAuthorWork, invalid, noAuthorEdition]));
      expect(rejected.outcome).toBe('invalid-input');
      expect(rejected.exchanges).toEqual([]);
      expect(await observer.effects()).toEqual(effects);
    }
  } finally {
    await runtime.close();
  }
}, 300_000);
