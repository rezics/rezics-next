import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { proposeStatement } from '../../src/semantic/candidates.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { changeStatementDisclosure, readStatementAs } from '../../src/semantic/statement-disclosure.ts';
import type { FactClause } from '../../src/search/disclosure/check.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import {
  accounted,
  current,
  currentEvaluator,
  deadline,
  finishWitnessRepair,
  languageLeaf,
  leafFixture,
  leafReader,
  nativeRelease,
  requiredExport,
  stepBudget,
  statement,
  snak,
  routeKey,
  typeLeaf,
  type AliasReader,
  type BasisReader,
  type LeafEvidence,
  type LeafFixture,
  type LeafProgress,
  type TerminalReader,
} from './scope-leaf-evidence-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let f: LeafFixture;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  f = await leafFixture(db.pool, db.admin);
});
afterAll(async () => {
  if (db) await db.close();
});
const filter = { statement: { property: 'schema:inLanguage', in: ['ja'] } } as const;

// Every native regression establishes usable current selection and actual Access before resolving new ports.
test('admitted point leaves read only current selected property evidence with explicit native work receipts', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const evaluate = await currentEvaluator();
  const type = current(await read(db.pool, f.request(book, typeLeaf), f.options()));
  expect(type.type).toBe('schema:Book');
  expect(type.facts).toEqual([]);
  expect(type.coverage?.kind).toBe('selection');
  expect(type.progress).toBeNull();
  accounted(type, stepBudget());
  const compact = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(compact.facts.map((fact) => fact.statement)).toEqual([
    { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
  ]);
  expect(compact.coverage?.kind).toBe('selection');
  expect(evaluate(filter, [compact])).toBe(true);
  expect(evaluate({ not: filter }, [compact])).toBe(false);
  const candidate = await f.propose(book, 'schema:inLanguage', 'en');
  await f.accept(book, candidate);
  // Expanding the slot preserves the compact candidate until Global adopts the replacement.
  const expanded = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(evaluate(filter, [expanded])).toBe(true);
  const headRow = await db.admin.query(
    'SELECT head FROM semantic.adoption WHERE route=$1 AND subject_id=$2 ORDER BY head DESC LIMIT 1',
    [routeOf(book), book],
  );
  let head = await f.adopt(book, 'schema:inLanguage', [candidate], Number(headRow.rows[0].head), { rank: 'preferred' });
  const adopted = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(adopted.facts.map((fact) => [fact.statement.value, fact.rank])).toEqual([['en', 'preferred']]);
  expect(evaluate(filter, [adopted])).toBe(false);
  expect(evaluate({ not: filter }, [adopted])).toBe(true);
  head = await f.adopt(book, 'schema:inLanguage', [], head);
  const suppressed = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(suppressed.facts).toEqual([]);
  expect(suppressed.coverage?.kind).toBe('selection');
  await f.adopt(book, 'schema:inLanguage', [candidate], head);
  const restored = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  await f.hideCandidate(book, candidate);
  const final = await read(
    db.pool,
    { ...f.request(book, languageLeaf), revalidate: restored.facts[0]!.witness },
    f.options(),
  );
  expect(final.state !== 'current' || final.facts.length === 0).toBe(true);
  expect(JSON.stringify(final)).not.toContain('Native current leaf fixture');
  const source = subjectSource(db.pool);
  expect((await source.read(partitionOf(routeOf(book)!), [book])).subjects[0]!.statements).toEqual([]);
  expect((await source.count(partitionOf(routeOf(book)!))).count).toBeGreaterThan(0);
}, 120_000);

test('unresolved witness work advances bounded native progress beyond two hundred fifty six', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const evaluate = await currentEvaluator();
  for (const count of [257, 4096]) {
    const subject = count === 257 ? book : await f.baseline();
    const target = await f.create();
    const entries = await f.witnesses(subject, target, count);
    await finishWitnessRepair(db.pool, subject);
    // The recorded hint must be among the stale witnesses, in addition to the first32 alternatives.
    const hint = await db.admin.query(
      `SELECT v.witness_id FROM semantic.relation_facet_build b
       JOIN semantic.relation_facet_witness_value v
         ON v.route=b.route AND v.subject_id=b.subject_id AND v.generation=b.published
       WHERE b.route=$1 AND b.subject_id=$2 AND v.property=$3 AND v.value=$4`,
      [routeOf(subject), subject, 'ex:credit', target],
    );
    expect(hint.rows).toHaveLength(1);
    const recorded = hint.rows[0].witness_id as string;
    const survivor = entries.at(-1)!;
    expect(recorded, 'the published native hint must be stale in this fixture').not.toBe(survivor.candidate);
    for (const entry of entries) if (entry !== survivor) await f.hideCandidate(subject, entry.candidate);
    const leaf: FactClause = { facet: 'statement', property: 'ex:credit', values: [target] };
    const expression = { statement: { property: 'ex:credit', in: [target] } };
    let after: LeafProgress | null = null;
    let found: LeafEvidence | undefined;
    const visited = new Set<string>();
    let raw = 0;
    for (let step = 0; step < count + 10; step++) {
      const measured = await capture(db, () => read(db.pool, f.request(subject, leaf, after), f.options()));
      const evidence = current(measured.value);
      accounted(evidence, stepBudget());
      raw += evidence.usage.witnesses;
      const sql = costOf(measured.capture);
      expect(evidence.usage.rows).toBeGreaterThanOrEqual(sql.rows);
      expect(evidence.usage.keys).toBeLessThanOrEqual(17);
      expect(evidence.facts.every((fact) => fact.statement.value === target)).toBe(true);
      if (evaluate(expression, [evidence]) === true) {
        found = evidence;
        break;
      }
      expect(evaluate(expression, [evidence])).toBe('not_proven');
      expect(evaluate({ not: expression }, [evidence])).toBe('not_proven');
      expect(evidence.coverage).toBeNull();
      expect(evidence.progress).not.toBeNull();
      const next = JSON.stringify(evidence.progress);
      expect(visited.has(next), 'raw native progress must strictly advance, never repeat a sample').toBe(false);
      visited.add(next);
      if (after && evidence.progress?.phase === after.phase && evidence.progress.valueOrdinal === after.valueOrdinal)
        expect(evidence.progress.after! > after.after!).toBe(true);
      after = evidence.progress;
    }
    expect(found, `last eligible native witness ${count} must be reached`).toBeDefined();
    expect(raw).toBeGreaterThan(256);
    const positive = current(found!);
    expect(positive.facts.map((fact) => fact.statement.qualifiers)).toContainEqual([
      { property: 'ex:key', value: survivor.key },
    ]);
    const final = current(
      await read(db.pool, { ...f.request(subject, leaf), revalidate: positive.facts[0]!.witness }, f.options()),
    );
    accounted(final, stepBudget());
    expect(final.usage.witnesses).toBeGreaterThan(0);
    expect(final.usage.points).toBeGreaterThan(0);
    expect(evaluate(expression, [final])).toBe(true);
    await f.hideSubject(target);
    const hidden = await read(
      db.pool,
      { ...f.request(subject, leaf), revalidate: positive.facts[0]!.witness },
      f.options(),
    );
    expect(hidden.state !== 'current' || hidden.facts.length === 0).toBe(true);
    await f.hideSubject(target, 'restore');
    const visible = current(
      await read(db.pool, { ...f.request(subject, leaf), revalidate: positive.facts[0]!.witness }, f.options()),
    );
    expect(evaluate(expression, [visible])).toBe(true);
  }
}, 1_800_000);

test('current absence never comes from sampled or historically rejected witnesses', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const evaluate = await currentEvaluator();
  const target = await f.create();
  const entries = await f.witnesses(book, target, 40);
  await finishWitnessRepair(db.pool, book);
  for (const entry of entries) await f.hideCandidate(book, entry.candidate);
  const leaf: FactClause = { facet: 'statement', property: 'ex:credit', values: [target] };
  const expression = { statement: { property: 'ex:credit', in: [target] } };
  let after: LeafProgress | null = null;
  let last: LeafEvidence | undefined;
  for (let step = 0; step < 10; step++) {
    const evidence = current(await read(db.pool, f.request(book, leaf, after), f.options()));
    expect(evidence.facts).toEqual([]);
    expect(evidence.coverage).toBeNull();
    expect(evaluate({ not: expression }, [evidence])).toBe('not_proven');
    last = evidence;
    if (!evidence.progress) break;
    after = evidence.progress;
  }
  expect(last).toBeDefined();
  // Source-local moderation changes invalidate raw progress rather than certifying absence from old rejected pages.
  await f.hideCandidate(book, entries[0]!.candidate, 'restore');
  const old = await read(db.pool, f.request(book, leaf, after), f.options());
  expect(old.state).toBe('basis_changed');
  expect(evaluate({ not: expression }, [old])).not.toBe(true);
  await finishWitnessRepair(db.pool, book);
  const fresh = current(await read(db.pool, f.request(book, leaf), f.options()));
  expect(evaluate(expression, [fresh])).toBe(true);
  // A foreign target can restore behind an unchanged raw keyset without touching source selection.
  await f.hideSubject(target);
  let foreignAfter: LeafProgress | null = null;
  for (let step = 0; step < 10; step++) {
    const hidden = current(await read(db.pool, f.request(book, leaf, foreignAfter), f.options()));
    expect(hidden.coverage).toBeNull();
    expect(evaluate({ not: expression }, [hidden])).toBe('not_proven');
    if (!hidden.progress) break;
    foreignAfter = hidden.progress;
  }
  await f.hideSubject(target, 'restore');
  const resumed = await read(db.pool, f.request(book, leaf, foreignAfter), f.options());
  expect(resumed.state !== 'current' || resumed.coverage === null).toBe(true);
  expect(evaluate({ not: expression }, [resumed])).not.toBe(true);
  expect(evaluate(expression, [current(await read(db.pool, f.request(book, leaf), f.options()))])).toBe(true);
  // Complete possible-pair absence is independent of sampled overflow and has no foreign witness to invalidate.
  const absent = await f.create();
  const absentLeaf: FactClause = { facet: 'statement', property: 'ex:credit', values: [absent] };
  const empty = current(await read(db.pool, f.request(book, absentLeaf), f.options()));
  accounted(empty, stepBudget());
  expect(empty.usage.points).toBeGreaterThan(0);
  expect(empty.usage.emptySeeks).toBeGreaterThan(0);
  expect(empty.facts).toEqual([]);
  expect(empty.coverage?.kind).toBe('empty_pair');
  expect(empty.progress).toBeNull();
  expect(evaluate({ not: { statement: { property: 'ex:credit', in: [absent] } } }, [empty])).toBe(true);
}, 300_000);

test('leaf reservations reject before SQL and deadline and unavailable errors remain errors', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  for (const key of Object.keys(stepBudget()) as (keyof ReturnType<typeof stepBudget>)[]) {
    for (const value of [0, -1, 0.5, NaN, Infinity]) {
      const measured = await capture(db, async () => {
        await expect(
          read(db.pool, { ...f.request(book, languageLeaf), budget: { ...stepBudget(), [key]: value } }, f.options()),
        ).rejects.toBeInstanceOf(RangeError);
      });
      expect(costOf(measured.capture).statements).toBe(0);
    }
  }
  const malformed = await capture(db, async () => {
    await expect(
      read(db.pool, { ...f.request(book, languageLeaf), leaf: { and: [] } as unknown as FactClause }, f.options()),
    ).rejects.toThrow();
  });
  expect(costOf(malformed.capture).statements).toBe(0);
  await expect(
    read(db.pool, f.request(book, languageLeaf), { ...f.options(), deadline: Date.now() - 1 }),
  ).rejects.toThrow();
  const partition = partitionOf(routeOf(book)!);
  const previous = (await db.admin.query('SELECT write_state FROM core.partition WHERE partition_no=$1', [partition]))
    .rows[0].write_state;
  try {
    await db.admin.query(
      "UPDATE core.partition SET write_state='moved', moved_to='https://unavailable.example.test' WHERE partition_no=$1",
      [partition],
    );
    await expect(read(db.pool, f.request(book, languageLeaf), f.options())).rejects.toThrow();
  } finally {
    await db.admin.query('UPDATE core.partition SET write_state=$2, moved_to=NULL WHERE partition_no=$1', [
      partition,
      previous,
    ]);
  }
}, 120_000);

test('current selected meaning and foreign authority invalidate unsafe leaf continuations and final positives', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const before = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  // Neither an unrelated subject nor ordinary partition movement restarts source-local evidence.
  await f.create('schema:Person', {}, routeOf(book)!);
  const unchanged = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(unchanged.basis).toBe(before.basis);
  const candidate = await f.propose(book, 'schema:inLanguage', 'en');
  await f.accept(book, candidate);
  const heads = await db.admin.query(
    'SELECT max(head) AS head FROM semantic.adoption WHERE route=$1 AND subject_id=$2',
    [routeOf(book), book],
  );
  await f.adopt(book, 'schema:inLanguage', [candidate], Number(heads.rows[0].head));
  const stale: LeafProgress = { basis: before.basis, phase: 'selection', valueOrdinal: 0, after: '0' };
  expect((await read(db.pool, f.request(book, languageLeaf, stale), f.options())).state).toBe('basis_changed');
  const final = await read(
    db.pool,
    { ...f.request(book, languageLeaf), revalidate: before.facts[0]!.witness },
    f.options(),
  );
  expect(final.state !== 'current' || final.facts.length === 0).toBe(true);
  await f.hideSubject(book);
  const hidden = await read(db.pool, f.request(book, typeLeaf), f.options());
  expect(hidden.state).toBe('not_ready');
  expect(Object.keys(hidden).sort()).toEqual(['state', 'usage']);
}, 120_000);

test('native identity ports and one-owner raw progress preserve independent alias continuation in eight encrypted keys', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const basisReader = await requiredExport<BasisReader>('semantic/identity-basis', 'readIdentityBasis');
  const terminalReader = await requiredExport<TerminalReader>(
    'semantic/terminal-identity',
    'readTerminalSubjectIdentity',
  );
  const aliases = await requiredExport<AliasReader>('semantic/alias-group', 'readSubjectAliasGroup');
  const pool = db.openPool({ max: 1 });
  try {
    const terminal = await terminalReader(pool, book, f.options());
    expect(terminal?.state).toBe('ready');
    // Actual metadata work is separately measured, not hidden in each candidate leaf's receipt.
    const sweep = await capture(db, () => basisReader(pool, { deadline: deadline() }));
    expect(sweep.value.state).toBe('ready');
    expect(costOf(sweep.capture).rows).toBeGreaterThanOrEqual(8192);
    if (sweep.value.state !== 'ready') throw new Error('Expected ready structural basis');
    const window = await aliases(pool, {
      terminal: book,
      basis: sweep.value.basis,
      after: null,
      limit: 16,
      deadline: deadline(),
    });
    expect(window.state).toBe('ready');
    if (window.state !== 'ready') throw new Error('Expected real alias window');
    expect(window.originals).toContain(book);
    const evidence = current(await read(pool, f.request(book, languageLeaf), f.options()));
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    // The fixed raw wire has no leaf truth, nested tokens, or variable JSON payload.
    const record = Buffer.alloc(18);
    record[0] = (1 << 5) | 0; // version1, deterministic leaf0
    record[1] = (1 << 6) | 0; // selection phase, value0
    record.writeBigUInt64BE(16n, 2);
    const sourceAfter = record.toString('base64url');
    expect(sourceAfter.length).toBe(24);
    const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(83)]]) };
    const binding = {
      route: 'GET /v1/zones/{id}/subjects',
      viewer: null,
      query: { zone: book, query: 'current-evidence', limit: 100 },
    };
    const position = [sweep.value.basis.digest, '', book, 0, book, sourceAfter, evidence.basis, 1];
    const token = await encodeListCursor(ring, binding, { epoch: 1, after: position }, new Date());
    const decoded = await decodeListCursor(ring, binding, token, new Date());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.after).toEqual(position);
    expect(
      await decodeListCursor(ring, { ...binding, query: { ...binding.query, limit: 99 } }, token, new Date()),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect((await decodeListCursor(ring, { ...binding, viewer: newIdForBinding }, token, new Date())).ok).toBe(false);
  } finally {
    await pool.end();
  }
}, 120_000);
const newIdForBinding = '019a1b2c-3d4e-7f00-8a00-ed170e000083';

test('last native alias remains discoverable through actual bounded group maintenance', async () => {
  const root = await f.baseline();
  await leafReader();
  const basisReader = await requiredExport<BasisReader>('semantic/identity-basis', 'readIdentityBasis');
  const terminalReader = await requiredExport<TerminalReader>(
    'semantic/terminal-identity',
    'readTerminalSubjectIdentity',
  );
  const aliases = await requiredExport<AliasReader>('semantic/alias-group', 'readSubjectAliasGroup');
  for (const count of [257, 4096]) {
    const terminal = count === 257 ? root : await f.baseline();
    const originals: string[] = [];
    for (let index = 0; index < count; index++) originals.push(await f.create('schema:Book'));
    originals.sort();
    for (const original of originals) {
      await mergeSubjects(db.pool, {
        ...(await f.command('subject:merge')),
        subjects: [original, terminal],
        survivor: terminal,
        release: nativeRelease,
      });
      for (let page = 0; ; page++) {
        expect(page).toBeLessThan(1000);
        if (!(await moveMergePage(db.pool, original, terminal))) break;
      }
    }
    for (const original of originals.slice(0, -1)) await f.hideSubject(original);
    const basis = await basisReader(db.pool, { deadline: deadline() });
    expect(basis.state).toBe('ready');
    if (basis.state !== 'ready') throw new Error('Expected finite native identity maintenance');
    let after: string | null = null;
    let found = false;
    for (let step = 0; step < count; step++) {
      const window = await aliases(db.pool, { terminal, basis: basis.basis, after, limit: 16, deadline: deadline() });
      expect(window.state).toBe('ready');
      if (window.state !== 'ready') throw new Error('Expected advancing native aliases');
      expect(window.examined).toBeLessThanOrEqual(17);
      for (const original of window.originals) {
        const result = await terminalReader(db.pool, original, f.options());
        if (original === originals.at(-1)) {
          expect(result?.state).toBe('ready');
          found = true;
        }
      }
      if (found || window.exhausted) break;
      expect(window.after! > (after ?? '')).toBe(true);
      after = window.after;
    }
    expect(found).toBe(true);
  }
}, 1_800_000);

test('current normalized range unit and same-statement qualifier evidence uses the shared Search matcher', async () => {
  await f.baseline();
  const read = await leafReader();
  const evaluate = await currentEvaluator();
  const key = await f.create();
  const otherKey = await f.create();
  const recipe = await f.create('schema:Recipe', {
    'schema:datePublished': [
      statement('schema:datePublished', {
        time: '-0500-00-00T00:00:00Z',
        precision: 9,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      }),
    ],
    'schema:recipeYield': [statement('schema:recipeYield', { amount: '+4', unit: '1' }, [snak('ex:key', key)])],
  });
  const timeLeaf: FactClause = {
    facet: 'statement',
    property: 'schema:datePublished',
    range: { gte: -500, lte: -500 },
  };
  const quantityLeaf: FactClause = {
    facet: 'statement',
    property: 'schema:recipeYield',
    range: { gte: 4, lte: 4, unit: '1' },
    qualifiers: [{ property: 'ex:key', in: [key] }],
  };
  const time = current(await read(db.pool, f.request(recipe, timeLeaf), f.options()));
  const quantity = current(await read(db.pool, f.request(recipe, quantityLeaf), f.options()));
  expect(time.facts[0]!.statement.facet).toEqual({ kind: 'time', year: -500 });
  expect(quantity.facts[0]!.statement).toEqual({
    property: 'schema:recipeYield',
    value: '+4',
    facet: { kind: 'quantity', amount: 4, unit: '1' },
    qualifiers: [{ property: 'ex:key', value: key }],
  });
  const timeFilter = { statement: { property: 'schema:datePublished', range: { gte: -500, lte: -500 } } };
  const quantityFilter = {
    statement: {
      property: 'schema:recipeYield',
      range: { gte: 4, lte: 4, unit: '1' },
      qualifiers: [{ property: 'ex:key', in: [key] }],
    },
  };
  expect(evaluate(timeFilter, [time])).toBe(true);
  expect(evaluate(quantityFilter, [quantity])).toBe(true);
  expect(evaluate({ and: [timeFilter, quantityFilter] }, [time, quantity])).toBe(true);
  expect(evaluate({ or: [timeFilter, quantityFilter] }, [time, quantity])).toBe(true);
  const wrongUnit = {
    statement: { ...quantityFilter.statement, range: { gte: 4, lte: 4, unit: 'https://example.test/other-unit' } },
  };
  expect(evaluate(wrongUnit, [quantity])).toBe(false);
  const wrongQualifier = {
    statement: { ...quantityFilter.statement, qualifiers: [{ property: 'ex:key', in: [otherKey] }] },
  };
  expect(evaluate(wrongQualifier, [quantity])).toBe(false);
  expect(evaluate({ not: { and: [timeFilter, wrongQualifier] } }, [time, quantity])).toBe(true);
}, 120_000);

test('native imported source fences invalidate leaf progress and a final recorded witness without a relay', async () => {
  const book = await f.baseline();
  const read = await leafReader();
  const source = {
    source: 'openlibrary',
    external_id: randomUUID(),
    field_group: 'facts' as const,
    record_revision: 'unversioned',
    digest: 'e'.repeat(64),
    converter_revision: 'openlibrary@1',
  };
  const command = await f.command('statement:propose');
  const imported = await batchCommand(db.pool, {
    actor: f.editor,
    authorization: command.authorization,
    route: routeOf(book)!,
    release: nativeRelease,
    deadline: deadline(),
    clock: () => new Date(),
    command: {
      op: 'propose',
      key: randomUUID(),
      source,
      subject: book,
      statement: {
        property: { id: 'schema:inLanguage' },
        value: { type: 'value', content: 'en' },
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/import' } },
            ],
          },
        ],
      },
    },
  });
  expect(imported.status).toBe(201);
  if (!('candidate' in imported.value)) throw new Error('Expected native imported candidate');
  const candidate = imported.value.candidate;
  await f.accept(book, candidate);
  const row = await db.admin.query('SELECT max(head) AS head FROM semantic.adoption WHERE route=$1 AND subject_id=$2', [
    routeOf(book),
    book,
  ]);
  await f.adopt(book, 'schema:inLanguage', [candidate], Number(row.rows[0].head));
  const before = current(await read(db.pool, f.request(book, languageLeaf), f.options()));
  expect(before.facts[0]!.statement.value).toBe('en');
  await takedownSourceFence(
    { pool: db.pool, access: f.access, routeKey },
    f.editor,
    {
      source: source.source,
      external_id: source.external_id,
      field_group: 'facts',
      reason: 'Native final evidence fence',
    },
    { idempotencyKey: randomUUID(), deadline: deadline(), requestId: randomUUID() },
  );
  const final = await read(
    db.pool,
    { ...f.request(book, languageLeaf), revalidate: before.facts[0]!.witness },
    f.options(),
  );
  expect(final.state !== 'current' || final.facts.length === 0).toBe(true);
  expect(JSON.stringify(final)).not.toContain(source.external_id);
  const oldProgress: LeafProgress = { basis: before.basis, phase: 'selection', valueOrdinal: 0, after: '0' };
  expect((await read(db.pool, f.request(book, languageLeaf, oldProgress), f.options())).state).toBe('basis_changed');
}, 120_000);

test('public consent and terminal retraction cannot disclose a private body through internal leaf keys', async () => {
  await f.baseline();
  const read = await leafReader();
  const agent = await ensureAccountAgent(db.pool, { account: f.editor, kind: 'person', name: 'Consent authority' });
  const pen = await f.create();
  const proposed = await proposeStatement(db.pool, {
    ...(await f.command('statement:propose')),
    actor: f.editor,
    subject: pen,
    release: nativeRelease,
    statement: { ...statement('rezics:penNameOf', agent.subject.id), references: [] },
  });
  const leaf: FactClause = { facet: 'statement', property: 'rezics:penNameOf', values: [agent.subject.id] };
  const privateRead = await read(db.pool, f.request(pen, leaf), f.options());
  expect(privateRead.state !== 'current' || privateRead.facts.length === 0).toBe(true);
  // Even the owner/moderator cannot accidentally opt this internal public evidence read into a private overlay.
  const ownerRead = await readStatementAs(db.pool, f.access, f.editor, deadline(), () =>
    read(db.pool, f.request(pen, leaf), { ...f.options(), actor: f.editor }),
  );
  expect(ownerRead.state !== 'current' || ownerRead.facts.length === 0).toBe(true);
  expect(JSON.stringify(privateRead)).not.toContain(agent.subject.id);
  await changeStatementDisclosure(db.pool, {
    ...(await f.command('statement:propose')),
    actor: f.editor,
    candidate: proposed.candidate,
  });
  await finishWitnessRepair(db.pool, pen);
  const publicRead = current(await read(db.pool, f.request(pen, leaf), f.options()));
  expect(publicRead.facts[0]!.statement.value).toBe(agent.subject.id);
  await changeStatementDisclosure(db.pool, {
    ...(await f.command('statement:propose')),
    actor: f.editor,
    candidate: proposed.candidate,
    retract: true,
  });
  const final = await read(db.pool, { ...f.request(pen, leaf), revalidate: publicRead.facts[0]!.witness }, f.options());
  expect(final.state !== 'current' || final.facts.length === 0).toBe(true);
}, 120_000);
