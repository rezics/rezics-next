import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { ReaderLibraryStatusStore, READING_TOTALS_COST, type ReadingYear } from '../../../services/main/src/modules/library/status.ts';
import { WORK_RESUME_COST } from '../../../services/main/src/modules/continue/contract.ts';
import { meterStatements, seedHome, startHomeStack } from './feed-read-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type Resume = { work: string; nextUnread: { occurrence: string; title: string | null; href: string } | null;
  unreadCount: { value: number; kind: 'exact' | 'lower-bound' } | null;
  lastPosition: { occurrence: string; completed: boolean; position: string | null } | null };

test('G-552: SQL totals cover 1,000 status rows and 2,601 completions; a Work ranked 500th resumes independently', async () => {
  const home = await startHomeStack('g-552-library');
  try {
    // These reads consume the owner heads directly; feed materialization is
    // outside this fixture and is deliberately not part of preparation.
    const seeded = await seedHome({ ...home, project: () => Promise.resolve() }, 3), work = seeded.works[2]!.work;
    const ids = Array.from({ length: 1_000 }, (_, index) => index === 499 ? work : id());
    // Large owner inventory, beyond each former cap. Public metadata and the
    // resume Book are command-created; unrelated status rows need no graph data.
    await home.stack.contentPool.query(`INSERT INTO reader.library_status
      (agent, work, status, finished_on, version, changed_at)
      SELECT $1, work, CASE WHEN ordinal > 700 THEN 'read' ELSE 'reading' END,
        CASE WHEN ordinal > 700 THEN make_date(2026,
          CASE WHEN ordinal <= 800 THEN 1 WHEN ordinal <= 900 THEN 7 ELSE 12 END, 15) END,
        1, CASE WHEN ordinal < 500 THEN '2026-06-02'::timestamptz + ordinal * interval '1 second'
          WHEN ordinal = 500 THEN '2026-06-01'::timestamptz
          ELSE '2026-05-01'::timestamptz + ordinal * interval '1 second' END
      FROM unnest($2::text[]) WITH ORDINALITY AS fixture(work, ordinal)
      ON CONFLICT (agent, work) DO UPDATE SET changed_at = EXCLUDED.changed_at`, [seeded.reader, ids]);
    const ranked = await home.stack.contentPool.query<{ rank: string }>(`SELECT rank::text FROM (
      SELECT work, row_number() OVER (ORDER BY changed_at DESC, work DESC) AS rank
      FROM reader.library_status WHERE agent = $1 AND status = 'reading'
    ) AS ranked WHERE work = $2`, [seeded.reader, work]);
    expect(ranked.rows[0]!.rank).toBe('500');
    expect((await home.deps.libraryStatus.page(seeded.reader, 'reading', 8)).map(row => row.work)).not.toContain(work);
    const structureRows = (await home.stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(work)} rv:mainVersion ?main . ?structure rv:structureOf ?main ; rv:structureProfile rv:BookComposition .
      } } LIMIT 1`)).results!.bindings;
    const structure = structureRows[0]!.structure!.value;
    await home.stack.contentPool.query(`INSERT INTO structure.progress_command
      (principal_issuer, principal_subject, idempotency_key, request_digest, structure, occurrence,
        selection_key, result_version, result_completed, first_finish, created_at)
      SELECT $1,$2,'g-552-' || ordinal, $3,$4,occurrence,'',1,true,true,
        CASE WHEN ordinal <= 1300 THEN '2026-01-15'::timestamptz
          WHEN ordinal = 2601 THEN '2027-01-01 00:59:59+01'::timestamptz
          WHEN ordinal = 2602 THEN '2027-01-01 00:00:00+00'::timestamptz
          ELSE '2026-12-31 23:59:59+00'::timestamptz END
      FROM unnest($5::text[]) WITH ORDINALITY AS fixture(occurrence,ordinal)`,
    [home.reader.principal.issuer, home.reader.principal.subject, 'a'.repeat(64), structure,
      Array.from({ length: 2_602 }, id)]);
    const meter = meterStatements();
    try {
      const before = meter.count();
      const totals = await home.deps.libraryStatus.readingYear(seeded.reader, home.reader.principal, 2026);
      expect(meter.count() - before).toBe(READING_TOTALS_COST.sqlStatements);
      expect(totals).toMatchObject({ books: 300, chapters: 2_601 });
      expect(totals.months).toHaveLength(READING_TOTALS_COST.resultRows);
      expect(totals.months[0]).toEqual({ month: 1, books: 100, chapters: 1_300 });
      expect(totals.months[6]).toEqual({ month: 7, books: 100, chapters: 0 });
      expect(totals.months[11]).toEqual({ month: 12, books: 100, chapters: 1_301 });
      const zoned = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 1,
        options: '-c timezone=Pacific/Auckland' });
      try {
        expect(await new ReaderLibraryStatusStore(zoned).readingYear(seeded.reader, home.reader.principal, 2026))
          .toEqual(totals);
      } finally { await zoned.end(); }
      const summary = await home.call('GET', seeded.signed('/v1/me/reading-stats?year=2026'),
        undefined, home.reader.token);
      expect(summary.headers.get('cache-control')).toBe('private, no-store');
      expect(await home.json<ReadingYear>(summary)).toMatchObject(totals);
      expect(await home.deps.libraryStatus.readingYear(seeded.reader, home.author.principal, 2026))
        .toMatchObject({ books: 300, chapters: 0 });
      expect(await home.deps.libraryStatus.readingYear(seeded.reader, home.reader.principal, 2025))
        .toMatchObject({ books: 0, chapters: 0 });

      const path = seeded.signed(`/v1/me/continue/${work.slice(-36)}`);
      const graphBefore = home.stack.fuseki.queries, sqlBefore = meter.count();
      const first = await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token));
      expect(first).toMatchObject({ work, nextUnread: { title: 'Chapter 1' }, lastPosition: null,
        unreadCount: { value: 2, kind: 'exact' } });
      expect(home.stack.fuseki.queries - graphBefore).toBeLessThanOrEqual(WORK_RESUME_COST.graphCalls);
      expect(meter.count() - sqlBefore).toBeLessThanOrEqual(WORK_RESUME_COST.sqlStatements);
      const preview = await home.json<{ items: { work: string }[] }>(await home.call('GET',
        seeded.signed('/v1/me/continue'), undefined, home.reader.token));
      expect(preview.items).toHaveLength(0); // Neither candidate source contains this Book.
      // Hiding a preview card never hides an explicitly requested Work.
      await home.json(await home.call('PUT', `/v1/me/continue/${work.slice(-36)}/hidden`,
        { actingSubject: seeded.reader, hidden: true }, home.reader.token));
      expect(await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token))).toEqual(first);
      const occurrence = first.nextUnread!.occurrence;
      const progressPath = `/v1/compositions/${structure.slice(-36)}/occurrences/${occurrence.slice(-36)}/progress`;
      // Race a first progress save against a read that initially saw no progress.
      const original = home.deps.libraryStatus.progress.bind(home.deps.libraryStatus);
      let reads = 0;
      home.deps.libraryStatus.progress = async (...args) => {
        const result = await original(...args);
        if (++reads === 1) await home.json(await home.call('PUT', progressPath,
          { actingSubject: seeded.reader, expectedVersion: 0, completed: false, position: 'paragraph-2' }, home.reader.token));
        return result;
      };
      try {
        const raced = await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token));
        // workRead retries a moved, cursor-free GET within the same budget.
        expect(raced).toMatchObject({ nextUnread: first.nextUnread,
          lastPosition: { occurrence, completed: false, position: 'paragraph-2' } });
        expect(reads).toBe(4);
      }
      finally { home.deps.libraryStatus.progress = original; }
      const unfinished = await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token));
      expect(unfinished).toMatchObject({ nextUnread: first.nextUnread,
        lastPosition: { occurrence, completed: false, position: 'paragraph-2' } });
      await home.json(await home.call('PUT', progressPath,
        { actingSubject: seeded.reader, expectedVersion: 1, completed: true, position: null }, home.reader.token));
      const next = await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token));
      expect(next).toMatchObject({ nextUnread: { title: 'Chapter 2' }, unreadCount: { value: 1, kind: 'exact' } });
      expect(next.nextUnread!.occurrence).not.toBe(occurrence);
      await home.json(await home.call('PUT', `/v1/compositions/${structure.slice(-36)}/occurrences/${next.nextUnread!.occurrence.slice(-36)}/progress`,
        { actingSubject: seeded.reader, expectedVersion: 0, completed: true, position: null }, home.reader.token));
      expect(await home.json<Resume>(await home.call('GET', path, undefined, home.reader.token)))
        .toMatchObject({ nextUnread: null, unreadCount: null });
      const privateWork = await home.stack.privateWork(seeded.author);
      expect((await home.call('GET', seeded.signed(`/v1/me/continue/${privateWork.work.slice(-36)}`),
        undefined, home.reader.token)).status).toBe(404);
      const scope = `work:read:${privateWork.work}`;
      await home.stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await home.stack.accessPool.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`,
      [randomUUID(), home.reader.principalId, seeded.reader]);
      const grantId = randomUUID();
      await home.stack.accessPool.query(`INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour')`, [grantId, seeded.reader, scope]);
      const privatePath = seeded.signed(`/v1/me/continue/${privateWork.work.slice(-36)}`);
      expect(await home.json<Resume>(await home.call('GET', privatePath, undefined, home.reader.token)))
        .toMatchObject({ work: privateWork.work, nextUnread: null, unreadCount: null });
      await home.stack.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grantId]);
      expect((await home.call('GET', privatePath, undefined, home.reader.token)).status).toBe(404);
      expect((await home.call('GET', path)).status).toBe(401);
      // Preserve the current controller floor while denying the old reader.
      await home.stack.accessPool.query(`INSERT INTO access.representation
        (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity')`,
      [randomUUID(), home.author.principalId, seeded.reader]);
      await home.stack.accessPool.query(`UPDATE access.representation SET active = false
        WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`, [home.reader.principalId, seeded.reader]);
      expect((await home.call('GET', path, undefined, home.reader.token)).status).toBe(503);
      expect((await home.call('GET', seeded.signed('/v1/me/reading-stats?year=2026'),
        undefined, home.reader.token)).status).toBe(403);
      expect(meter.violations).toEqual([]);
    } finally { meter.restore(); }
  } finally { await home.stop(); }
}, 300_000);

test('G-552: a custom Collection of 250 occurrence members traverses all three API pages', async () => {
  const home = await startHomeStack('g-552-custom');
  try {
    const actor = await home.provision('Large shelf owner', home.author.token);
    const target = await home.stack.publicWork(actor);
    const collection = id();
    const created = await home.json<{ structure: string; revision: string }>(await home.call('POST', '/v1/collections',
      { collection, name: 'Large custom shelf', disclosure: 'public', actingSubject: actor }, home.author.token), 201);
    let head = created.revision;
    const expected: string[] = [];
    for (let start = 0; start < 250; start += 16) {
      const changed = await home.json<{ revision: string; occurrences: string[] }>(await home.call('POST',
        `/v1/collections/${collection.slice(-36)}/changes`, { actingSubject: actor, expectedHead: head,
          operations: Array.from({ length: Math.min(16, 250 - start) }, () => ({ op: 'insert', role: 'member',
            parent: created.structure, position: 'last', target: target.work, selection: { mode: 'follow-context' } })) },
        home.author.token));
      head = changed.revision;
      expected.push(...changed.occurrences);
    }
    const actual: string[] = [], sizes: number[] = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ actingSubject: actor, limit: '100', ...(after ? { after } : {}) });
      const page = await home.json<{ occurrences: { occurrence: string }[]; next: string | null }>(await home.call('GET',
        `/v1/collections/${collection.slice(-36)}?${query}`, undefined, home.author.token));
      sizes.push(page.occurrences.length);
      actual.push(...page.occurrences.map(row => row.occurrence));
      after = page.next ?? undefined;
    } while (after);
    expect(sizes).toEqual([100, 100, 50]);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(250);
  } finally { await home.stop(); }
}, 300_000);
