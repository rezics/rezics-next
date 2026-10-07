import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRIBUTION_CREATE_READ_COST, CONTRIBUTION_PROFILE, ContributionReadExpired,
  textContributionDigest, textContributionReceiptIri } from '../src/modules/contribution/draft.ts';
import { textContributionEditDigest } from '../src/modules/contribution/edit.ts';
import { readExactContributionDraft, readOriginalContributionCreateSource }
  from '../src/modules/contribution/history.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionReadBudgetExceeded, RevisionUnavailable,
  type RevisionReadBudget } from '../src/modules/work/history.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const editor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000015';
const currentHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000016';
const admission = '00000000-0000-4000-8000-000000000017';
const body = '私の原稿';
const language = 'ja';
const epoch = 'epoch-1';
const sequence = '4';
const dataset = 'urn:rezics:dataset:product';
const profile = 'https://rezics.com/definition/work-metadata-v1';

const term = (value: string) => ({ value });
type GraphRow = Record<string, { value: string }>;

function store(directory: string, state: Record<string, unknown> = {
  work, author, language, body, publication: 'draft',
}) {
  const manifestDigest = prepareComponent(directory, contribution, state, CONTRIBUTION_PROFILE);
  const manifest = JSON.parse(readFileSync(join(directory, manifestDigest), 'utf8')) as { payload: string };
  const payloadDigest = manifest.payload.slice(7);
  return { manifestDigest, payloadDigest,
    manifestBytes: statSync(join(directory, manifestDigest)).size,
    payloadBytes: statSync(join(directory, payloadDigest)).size };
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = join(import.meta.dir, '../../../.temp/contribution-create-source', randomUUID());
  mkdirSync(directory, { recursive: true });
  try { return await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function environment(directory: string, rows: (sparql: string, max?: number) => { results?: { bindings: GraphRow[] }; boolean?: boolean }) {
  const seen: { sparql: string; max?: number }[] = [];
  let reads = 0;
  const env = { fuseki: { query: async (sparql: string, max?: number) => {
    seen.push({ sparql, max });
    reads += 1;
    return rows(sparql, max);
  } }, objectDirectory: directory } as unknown as WorkActivationEnvironment;
  return { env, seen, reads: () => reads };
}

function receiptRow(overrides: Record<string, string> = {}): GraphRow {
  const values = { receipt: textContributionReceiptIri(admission),
    digest: textContributionDigest({ work, language, actingSubject: author, body }),
    admission, authority: '0', scope: `contribution:create:${work}`, work, author, language,
    contribution, revision, epoch, sequence, dataset, ...overrides };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, term(value)]));
}

function anchorRow(manifestDigest: string, overrides: Record<string, string> = {}): GraphRow {
  const values = { component: contribution, manifest: `urn:rezics:sha256:${manifestDigest}`,
    model: CONTRIBUTION_PROFILE, shape: CONTRIBUTION_PROFILE, dataset, epoch, sequence, ...overrides };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, term(value)]));
}

test('original create source reconciles the receipt with immutable bytes, not the current head', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const budget: RevisionReadBudget = { bytesLeft: files.manifestBytes + files.payloadBytes,
      signal: new AbortController().signal };
    const { env, seen } = environment(directory, sparql => ({ results: { bindings: [
      sparql.includes('rv:OperationReceipt') ? receiptRow() : anchorRow(files.manifestDigest)] } }));
    const source = await readOriginalContributionCreateSource(env, contribution, async () => true, { budget });
    expect(source).toMatchObject({ contribution, revision, work, author, language, body,
      receipt: textContributionReceiptIri(admission), admissionId: admission,
      scope: `contribution:create:${work}`,
      sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence } });
    expect(source.author).not.toBe(editor);
    expect(budget.bytesLeft).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen.every(query => query.sparql.includes('LIMIT 2')
      && query.max === CONTRIBUTION_CREATE_READ_COST.responseBytes)).toBe(true);
    expect(seen.every(query => !query.sparql.includes(currentHead)
      && !query.sparql.includes('rv:draftHead')
      && !query.sparql.includes('urn:rezics:graph:current'))).toBe(true);
  });
});

test('original create source stays concealed until the caller may read it', async () => {
  const { env, seen } = environment('', () => { throw new Error('queried before authorization'); });
  await expect(readOriginalContributionCreateSource(env, contribution, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(seen).toHaveLength(0);
});

test('a missing or duplicate create receipt is refused before revision bytes are read', async () => {
  for (const rows of [[], [receiptRow(), receiptRow()]]) {
    const { env, seen } = environment('', () => ({ results: { bindings: rows } }));
    const error = rows.length === 0 ? RevisionNotFound : RevisionCorrupt;
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true)).rejects.toBeInstanceOf(error);
    expect(seen).toHaveLength(1);
  }
});

test('a duplicate original revision anchor is refused', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const { env, seen } = environment(directory, sparql => ({ results: { bindings: sparql.includes('rv:OperationReceipt')
      ? [receiptRow()] : [anchorRow(files.manifestDigest), anchorRow(files.manifestDigest)] } }));
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
      .rejects.toThrow('original contribution create revision is ambiguous');
    expect(seen).toHaveLength(2);
  });
});

test('an edit admission is not accepted as the original create actor', async () => {
  const { env, seen } = environment('', () => ({ results: { bindings: [receiptRow({
    scope: `contribution:edit:${contribution}`, author: editor })] } }));
  await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
    .rejects.toThrow('original contribution create source is an edit admission');
  expect(seen).toHaveLength(1);
});

test('a predecessor means the revision is not the original create', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const row = anchorRow(files.manifestDigest);
    row.predecessor = term(currentHead);
    const { env, reads } = environment(directory, sparql => ({ results: { bindings: [
      sparql.includes('rv:OperationReceipt') ? receiptRow() : row] } }));
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
      .rejects.toThrow('original contribution create revision has a predecessor');
    expect(reads()).toBe(2);
  });
});

test('wrong create fields, model, recipe, language and source position are refused', async () => {
  await withDirectory(async directory => {
    const otherWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000018';
    const cases: { name: string; receipt?: Record<string, string>; anchor?: Record<string, string>;
      state?: Record<string, unknown>; message: string }[] = [
      { name: 'work', state: { work: otherWork, author, language, body, publication: 'draft' },
        message: 'work does not match' },
      { name: 'author', state: { work, author: editor, language, body, publication: 'draft' },
        message: 'author does not match' },
      { name: 'language', state: { work, author, language: 'en', body, publication: 'draft' },
        message: 'language does not match' },
      { name: 'recipe', state: { work, author, language, body, publication: 'public' },
        message: 'not the draft recipe' },
      { name: 'digest', receipt: { digest: textContributionEditDigest({ contribution,
        expectedHead: currentHead, actingSubject: editor, body }) },
        message: 'digest differs from immutable bytes' },
      { name: 'model', anchor: { model: profile }, message: 'model does not match' },
      { name: 'position', anchor: { sequence: '9' }, message: 'source position does not match' },
    ];
    for (const item of cases) {
      const directoryCase = join(directory, item.name);
      mkdirSync(directoryCase);
      const written = store(directoryCase, item.state);
      const { env } = environment(directoryCase, sparql => ({ results: { bindings: [
        sparql.includes('rv:OperationReceipt') ? receiptRow(item.receipt) : anchorRow(written.manifestDigest, item.anchor)] } }));
      await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
        .rejects.toThrow(item.message);
    }
  });
});

test('missing and corrupt original objects are refused', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    rmSync(join(directory, files.payloadDigest));
    const missing = environment(directory, sparql => ({ results: { bindings: [
      sparql.includes('rv:OperationReceipt') ? receiptRow() : anchorRow(files.manifestDigest)] } }));
    await expect(readOriginalContributionCreateSource(missing.env, contribution, async () => true))
      .rejects.toBeInstanceOf(RevisionUnavailable);
    const again = store(directory);
    const payloadPath = join(directory, again.payloadDigest);
    const payload = readFileSync(payloadPath);
    payload[payload.length - 1] ^= 0xff;
    writeFileSync(payloadPath, payload);
    const corrupt = environment(directory, sparql => ({ results: { bindings: [
      sparql.includes('rv:OperationReceipt') ? receiptRow() : anchorRow(again.manifestDigest)] } }));
    await expect(readOriginalContributionCreateSource(corrupt.env, contribution, async () => true))
      .rejects.toThrow('immutable object digest differs');
  });
});

test('manifest and payload share one byte budget', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const budget: RevisionReadBudget = { bytesLeft: files.manifestBytes + files.payloadBytes - 1,
      signal: new AbortController().signal };
    const { env, seen } = environment(directory, sparql => ({ results: { bindings: [
      sparql.includes('rv:OperationReceipt') ? receiptRow() : anchorRow(files.manifestDigest)] } }));
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true, { budget }))
      .rejects.toBeInstanceOf(RevisionReadBudgetExceeded);
    expect(budget.bytesLeft).toBe(files.payloadBytes - 1);
    expect(seen).toHaveLength(2);
  });
});

test('caller cancellation and one deadline are checked across both original-create awaits', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const idle = environment('', () => { throw new Error('queried after cancellation'); });
  await expect(readOriginalContributionCreateSource(idle.env, contribution, async () => true,
    { signal: cancelled.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
  expect(idle.seen).toHaveLength(0);

  const between = new AbortController();
  const first = environment('', sparql => {
    if (!sparql.includes('rv:OperationReceipt')) throw new Error('revision query after expiry');
    between.abort();
    return { results: { bindings: [receiptRow()] } };
  });
  await expect(readOriginalContributionCreateSource(first.env, contribution, async () => true,
    { signal: between.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
  expect(first.seen).toHaveLength(1);

  const deadlines: { duration: number; controller: AbortController }[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
    const controller = new AbortController();
    deadlines.push({ duration, controller });
    return controller.signal;
  });
  try {
    const second = environment('', sparql => {
      if (sparql.includes('rv:OperationReceipt')) return { results: { bindings: [receiptRow()] } };
      deadlines[0]!.controller.abort();
      return { results: { bindings: [anchorRow('a'.repeat(64))] } };
    });
    await expect(readOriginalContributionCreateSource(second.env, contribution, async () => true))
      .rejects.toBeInstanceOf(ContributionReadExpired);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]!.duration).toBe(CONTRIBUTION_CREATE_READ_COST.deadlineMs);
    expect(second.seen).toHaveLength(2);
  } finally { timeout.mockRestore(); }
});

test('exact draft history stays authorized, bounded, and able to read an edited revision', async () => {
  const hidden = environment('', () => { throw new Error('queried before authorization'); });
  await expect(readExactContributionDraft(hidden.env, contribution, revision, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(hidden.seen).toHaveLength(0);

  const ambiguous = environment('', () => ({ results: { bindings: [anchorRow('ab'.repeat(32)), anchorRow('cd'.repeat(32))] } }));
  await expect(readExactContributionDraft(ambiguous.env, contribution, revision, async () => true))
    .rejects.toThrow('draft revision anchor is ambiguous');
  expect(ambiguous.seen).toHaveLength(1);
  expect(ambiguous.seen[0]!.sparql).toContain('LIMIT 2');
  expect(ambiguous.seen[0]!.max).toBe(CONTRIBUTION_CREATE_READ_COST.responseBytes);

  await withDirectory(async directory => {
    const edited = '改稿';
    const files = store(directory, { work, author, language, body: edited, publication: 'draft' });
    const row = anchorRow(files.manifestDigest);
    row.predecessor = term(revision);
    const { env, seen } = environment(directory, sparql => sparql.includes('ASK')
      ? { boolean: true } : { results: { bindings: [row] } });
    const draft = await readExactContributionDraft(env, contribution, currentHead, async () => true);
    expect(draft).toMatchObject({ body: edited, predecessor: revision, author,
      sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence } });
    expect(seen.some(query => query.sparql.includes('rv:OperationReceipt'))).toBe(false);
    expect(seen.some(query => query.sparql.includes('ASK'))).toBe(true);

    const budget: RevisionReadBudget = { bytesLeft: 1, signal: new AbortController().signal };
    const exhausted = environment(directory, sparql => {
      if (sparql.includes('ASK')) throw new Error('identity query after byte exhaustion');
      return { results: { bindings: [row] } };
    });
    await expect(readExactContributionDraft(exhausted.env, contribution, currentHead, async () => true, { budget }))
      .rejects.toBeInstanceOf(RevisionReadBudgetExceeded);
    expect(exhausted.seen).toHaveLength(1);

    const expired = new AbortController();
    const late = environment(directory, sparql => {
      if (sparql.includes('ASK')) throw new Error('identity query after expiry');
      expired.abort();
      return { results: { bindings: [row] } };
    });
    await expect(readExactContributionDraft(late.env, contribution, currentHead, async () => true,
      { signal: expired.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
    expect(late.seen).toHaveLength(1);
  });
});
