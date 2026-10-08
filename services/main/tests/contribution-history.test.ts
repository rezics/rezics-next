import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FusekiClient, fusekiReadBudget, FusekiReadBudgetExceeded }
  from '../src/infrastructure/fuseki.ts';
import { canonicalLanguage } from '../src/modules/display-language/select.ts';
import { CONTRIBUTION_CREATE_READ_COST, CONTRIBUTION_PROFILE, ContributionReadExpired,
  textContributionDigest, textContributionReceiptIri } from '../src/modules/contribution/draft.ts';
import { textContributionEditDigest, textContributionEditReceiptIri } from '../src/modules/contribution/edit.ts';
import { readExactContributionDraft, readOriginalContributionCreateSource,
  readOriginalContributionEditSource } from '../src/modules/contribution/history.ts';
import { GRAPHS, RV, iri, prepareComponent, type WorkActivationEnvironment }
  from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionReadBudgetExceeded, RevisionUnavailable,
  type RevisionReadBudget } from '../src/modules/work/history.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const editor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000013';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000015';
const currentHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000016';
const admission = '00000000-0000-4000-8000-000000000017';
const operation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000019';
const otherContribution = 'https://rezics.com/id/00000000-0000-4000-8000-00000000001a';
const body = '私の原稿';
const language = 'en-us';
const epoch = 'epoch-1';
const sequence = '4';
const dataset = 'urn:rezics:dataset:product';
const profile = 'https://rezics.com/definition/work-metadata-v1';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

type Term = { type: 'uri' | 'literal'; value: string; datatype?: string; 'xml:lang'?: string };
type Triple = { graph: string; subject: string; predicate: string; object: Term };
const uri = (value: string): Term => ({ type: 'uri', value });
const plain = (value: string): Term => ({ type: 'literal', value, datatype: XSD_STRING });
const integer = (value: string): Term => ({ type: 'literal', value, datatype: XSD_INTEGER });
const term = (value: string) => ({ value });

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

function receiptTriples(digest: string, extra: Triple[] = [], objects: Record<string, Term> = {},
  subject = textContributionReceiptIri(admission)): Triple[] {
  const terms: Record<string, Term> = {
    [RDF_TYPE]: uri(`${RV}OperationReceipt`),
    [`${RV}operation`]: uri(operation),
    [`${RV}requestDigest`]: plain(digest),
    [`${RV}admissionId`]: plain(admission),
    [`${RV}authorityEpoch`]: plain('0'),
    [`${RV}admittedScope`]: plain(`contribution:create:${work}`),
    [`${RV}outcome`]: uri(`${RV}Succeeded`),
    [`${RV}work`]: uri(work),
    [`${RV}contribution`]: uri(contribution),
    [`${RV}draftRevision`]: uri(revision),
    [`${RV}language`]: plain(language),
    [`${RV}author`]: uri(author),
    [`${RV}datasetId`]: uri(dataset),
    [`${RV}dataEpoch`]: plain(epoch),
    [`${RV}sequence`]: integer(sequence),
    ...objects,
  };
  return [...Object.entries(terms).map(([predicate, object]) => ({
    graph: GRAPHS.receipts, subject, predicate, object })), ...extra];
}

function anchorTriples(manifestDigest: string, extra: Triple[] = [], objects: Record<string, Term> = {},
  subject = revision): Triple[] {
  const terms: Record<string, Term> = {
    [RDF_TYPE]: uri(`${RV}RevisionAnchor`),
    [`${RV}component`]: uri(contribution),
    [`${RV}operation`]: uri(operation),
    [`${RV}manifest`]: uri(`urn:rezics:sha256:${manifestDigest}`),
    [`${RV}modelRevision`]: uri(CONTRIBUTION_PROFILE),
    [`${RV}shapeRevision`]: uri(CONTRIBUTION_PROFILE),
    [`${RV}datasetId`]: uri(dataset),
    [`${RV}dataEpoch`]: plain(epoch),
    [`${RV}sequence`]: integer(sequence),
    ...objects,
  };
  return [...Object.entries(terms).map(([predicate, object]) => ({
    graph: GRAPHS.revisions, subject, predicate, object })), ...extra];
}

/** Discovery returns receipt IRIs only. A subject read returns every stored triple. */
function evaluate(sparql: string, triples: readonly Triple[]): { results: { bindings: Record<string, Term>[] } } {
  const limit = Number(/LIMIT\s+(\d+)/.exec(sparql)?.[1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('contribution read is unbounded');
  if (/SELECT\s+\?p\s+\?o\b/.test(sparql)) {
    const graph = /GRAPH <([^>]+)>/.exec(sparql)?.[1];
    const subject = /GRAPH <[^>]+>\s*\{\s*<([^>]+)>\s+\?p\s+\?o/.exec(sparql)?.[1];
    if (!graph || !subject || sparql.includes('?s ?p ?o')) throw new Error('subject read is not bound');
    const rows = triples.filter(item => item.graph === graph && item.subject === subject).slice(0, limit);
    return { results: { bindings: rows.map(item => ({ p: uri(item.predicate), o: item.object })) } };
  }
  if (!/SELECT\s+\?receipt\b/.test(sparql) || sparql.includes('?author') || sparql.includes('?digest')) {
    throw new Error(`discovery projects fields: ${sparql.slice(0, 160)}`);
  }
  const hidesEdit = /FILTER NOT EXISTS[\s\S]*expectedHead/.test(sparql);
  const subjects = [...new Set(triples.filter(item => item.graph === GRAPHS.receipts).map(item => item.subject))];
  const matched: string[] = [];
  for (const subject of subjects) {
    const local = triples.filter(item => item.graph === GRAPHS.receipts && item.subject === subject);
    const has = (predicate: string, value?: string) => local.some(item => item.predicate === predicate
      && (value === undefined || item.object.value === value));
    if (!has(RDF_TYPE, `${RV}OperationReceipt`) || !has(`${RV}contribution`, contribution)) continue;
    if (hidesEdit && has(`${RV}expectedHead`)) continue;
    const scopes = local.filter(item => item.predicate === `${RV}admittedScope`
      && item.object.value.startsWith('contribution:create:'));
    if (sparql.includes('contribution:create:') && scopes.length === 0) continue;
    matched.push(...(scopes.length > 0 ? scopes.map(() => subject) : [subject]));
  }
  return { results: { bindings: matched.slice(0, limit).map(receipt => ({ receipt: uri(receipt) })) } };
}

function environment(directory: string, triples: readonly Triple[], onQuery?: (sparql: string) => void) {
  const seen: { sparql: string; max?: number }[] = [];
  const env = { fuseki: { query: async (sparql: string, max?: number) => {
    seen.push({ sparql, max });
    onQuery?.(sparql);
    if (sparql.includes('ASK')) return { boolean: true };
    return evaluate(sparql, triples);
  } }, objectDirectory: directory } as unknown as WorkActivationEnvironment;
  return { env, seen };
}

function currentWorkAdmission(env: WorkActivationEnvironment): (target: string) => Promise<boolean> {
  return async target => {
    const current = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX schema: <https://schema.org/> ASK {
        GRAPH <urn:rezics:graph:current> {
          ${iri(target)} a rv:TextContribution ; rv:work ?work .
          ?work a schema:CreativeWork .
        }
      }`);
    return current.boolean === true;
  };
}

const asFetch = (transport: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) =>
  transport as typeof globalThis.fetch;

test('original create source keeps the admitted en-us spelling and the immutable bytes', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const budget: RevisionReadBudget = { bytesLeft: files.manifestBytes + files.payloadBytes,
      signal: new AbortController().signal };
    const triples = [...receiptTriples(digest), ...anchorTriples(files.manifestDigest)];
    const { env, seen } = environment(directory, triples);
    const source = await readOriginalContributionCreateSource(env, contribution, async () => true, { budget });
    expect(canonicalLanguage(language)).toBe('en-US');
    expect(source).toMatchObject({ contribution, revision, work, author, language, body,
      receipt: textContributionReceiptIri(admission), admissionId: admission,
      scope: `contribution:create:${work}`,
      sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence } });
    expect(source.author).not.toBe(editor);
    expect(budget.bytesLeft).toBe(0);
    expect(seen.map(query => query.sparql)).toHaveLength(3);
    expect(seen[0]!.sparql).toContain('SELECT ?receipt');
    expect(seen[0]!.sparql).toContain('LIMIT 2');
    expect(seen[1]!.sparql).toContain(`<${textContributionReceiptIri(admission)}> ?p ?o`);
    expect(seen[1]!.sparql).toContain('LIMIT 16');
    expect(seen[2]!.sparql).toContain(`<${revision}> ?p ?o`);
    expect(seen[2]!.sparql).toContain('LIMIT 10');
    expect(seen.every(query => query.max === CONTRIBUTION_CREATE_READ_COST.responseBytes
      && !query.sparql.includes('FILTER NOT EXISTS')
      && !query.sparql.includes(currentHead)
      && !query.sparql.includes('rv:draftHead')
      && !query.sparql.includes(GRAPHS.current))).toBe(true);
  });
});

test('original create source stays concealed until the caller may read it', async () => {
  const { env, seen } = environment('', [], () => { throw new Error('queried before authorization'); });
  await expect(readOriginalContributionCreateSource(env, contribution, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(seen).toHaveLength(0);
});

test('a missing or duplicate create receipt is refused before its triples are accepted', async () => {
  const digest = textContributionDigest({ work, language, actingSubject: author, body });
  const second = '00000000-0000-4000-8000-00000000001b';
  const cases = [[], [...receiptTriples(digest), ...receiptTriples(digest, [], {}, textContributionReceiptIri(second))]];
  for (const triples of cases) {
    const { env, seen } = environment('', triples);
    const error = triples.length === 0 ? RevisionNotFound : RevisionCorrupt;
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true)).rejects.toBeInstanceOf(error);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sparql).toContain('SELECT ?receipt');
  }
});

test('literal IRIs and conflicting receipt or revision terms are refused from the subject', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const receipt = textContributionReceiptIri(admission);
    const cases: { name: string; extra?: Triple[]; objects?: Record<string, Term>; anchorObjects?: Record<string, Term>;
      anchorExtra?: Triple[]; message: string }[] = [
      { name: 'literal-work', objects: { [`${RV}work`]: plain(work) }, message: 'term type is invalid' },
      { name: 'literal-author', objects: { [`${RV}author`]: plain(author) }, message: 'term type is invalid' },
      { name: 'literal-model', anchorObjects: { [`${RV}modelRevision`]: plain(CONTRIBUTION_PROFILE) },
        message: 'term type is invalid' },
      { name: 'literal-manifest', anchorObjects: { [`${RV}manifest`]: plain(`urn:rezics:sha256:${files.manifestDigest}`) },
        message: 'term type is invalid' },
      { name: 'outcome', extra: [{ graph: GRAPHS.receipts, subject: receipt, predicate: `${RV}outcome`,
        object: uri(`${RV}Cancelled`) }], message: 'source conflicts' },
      { name: 'scope', extra: [{ graph: GRAPHS.receipts, subject: receipt, predicate: `${RV}admittedScope`,
        object: plain(`contribution:edit:${contribution}`) }], message: 'edit admission' },
      { name: 'target', extra: [{ graph: GRAPHS.receipts, subject: receipt, predicate: `${RV}contribution`,
        object: uri(otherContribution) }], message: 'source conflicts' },
      { name: 'expected-head', extra: [{ graph: GRAPHS.receipts, subject: receipt, predicate: `${RV}expectedHead`,
        object: uri(currentHead) }], message: 'edit receipt' },
    ];
    for (const item of cases) {
      const triples = [...receiptTriples(digest, item.extra, item.objects),
        ...anchorTriples(files.manifestDigest, item.anchorExtra, item.anchorObjects)];
      const { env, seen } = environment(directory, triples);
      await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
        .rejects.toThrow(item.message);
      expect(seen.some(query => query.sparql.includes('?p ?o'))).toBe(true);
      expect(seen.some(query => query.sparql.includes('FILTER NOT EXISTS'))).toBe(false);
    }
  });
});

test('a duplicate original revision manifest is refused', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const extra: Triple[] = [{ graph: GRAPHS.revisions, subject: revision, predicate: `${RV}manifest`,
      object: uri(`urn:rezics:sha256:${'ab'.repeat(32)}`) }];
    const { env, seen } = environment(directory, [...receiptTriples(digest), ...anchorTriples(files.manifestDigest, extra)]);
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
      .rejects.toThrow('original contribution create revision is ambiguous');
    expect(seen).toHaveLength(3);
  });
});

test('an edit-only receipt is not the original create source', async () => {
  const digest = textContributionDigest({ work, language, actingSubject: author, body });
  const triples = receiptTriples(digest, [], { [`${RV}admittedScope`]: plain(`contribution:edit:${contribution}`),
    [`${RV}author`]: uri(editor) });
  const { env, seen } = environment('', triples);
  await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(seen).toHaveLength(1);
});

test('a predecessor means the revision is not the original create', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const extra: Triple[] = [{ graph: GRAPHS.revisions, subject: revision, predicate: `${RV}predecessor`,
      object: uri(currentHead) }];
    const { env, seen } = environment(directory, [...receiptTriples(digest), ...anchorTriples(files.manifestDigest, extra)]);
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
      .rejects.toThrow('original contribution create revision has a predecessor');
    expect(seen).toHaveLength(3);
  });
});

test('wrong create fields, model, recipe, language and source position are refused', async () => {
  await withDirectory(async directory => {
    const otherWork = 'https://rezics.com/id/00000000-0000-4000-8000-000000000018';
    const cases: { name: string; state?: Record<string, unknown>; objects?: Record<string, Term>;
      anchorObjects?: Record<string, Term>; message: string }[] = [
      { name: 'work', state: { work: otherWork, author, language, body, publication: 'draft' },
        message: 'work does not match' },
      { name: 'author', state: { work, author: editor, language, body, publication: 'draft' },
        message: 'author does not match' },
      { name: 'language', state: { work, author, language: 'en', body, publication: 'draft' },
        message: 'language does not match' },
      { name: 'recipe', state: { work, author, language, body, publication: 'public' },
        message: 'not the draft recipe' },
      { name: 'digest', objects: { [`${RV}requestDigest`]: plain(textContributionEditDigest({ contribution,
        expectedHead: currentHead, actingSubject: editor, body })) },
        message: 'digest differs from immutable bytes' },
      { name: 'model', anchorObjects: { [`${RV}modelRevision`]: uri(profile) }, message: 'model does not match' },
      { name: 'position', anchorObjects: { [`${RV}sequence`]: integer('9') }, message: 'source position does not match' },
    ];
    for (const item of cases) {
      const directoryCase = join(directory, item.name);
      mkdirSync(directoryCase);
      const written = store(directoryCase, item.state);
      const digest = textContributionDigest({ work, language, actingSubject: author, body });
      const { env } = environment(directoryCase, [...receiptTriples(digest, [], item.objects),
        ...anchorTriples(written.manifestDigest, [], item.anchorObjects)]);
      await expect(readOriginalContributionCreateSource(env, contribution, async () => true))
        .rejects.toThrow(item.message);
    }
  });
});

test('missing and corrupt original objects are refused', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    rmSync(join(directory, files.payloadDigest));
    const missing = environment(directory, [...receiptTriples(digest), ...anchorTriples(files.manifestDigest)]);
    await expect(readOriginalContributionCreateSource(missing.env, contribution, async () => true))
      .rejects.toBeInstanceOf(RevisionUnavailable);
    const again = store(directory);
    const payloadPath = join(directory, again.payloadDigest);
    const payload = readFileSync(payloadPath);
    payload[payload.length - 1] ^= 0xff;
    writeFileSync(payloadPath, payload);
    const corrupt = environment(directory, [...receiptTriples(digest), ...anchorTriples(again.manifestDigest)]);
    await expect(readOriginalContributionCreateSource(corrupt.env, contribution, async () => true))
      .rejects.toThrow('immutable object digest differs');
  });
});

test('manifest and payload share one byte budget', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const budget: RevisionReadBudget = { bytesLeft: files.manifestBytes + files.payloadBytes - 1,
      signal: new AbortController().signal };
    const { env, seen } = environment(directory, [...receiptTriples(digest), ...anchorTriples(files.manifestDigest)]);
    await expect(readOriginalContributionCreateSource(env, contribution, async () => true, { budget }))
      .rejects.toBeInstanceOf(RevisionReadBudgetExceeded);
    expect(budget.bytesLeft).toBe(files.payloadBytes - 1);
    expect(seen).toHaveLength(3);
  });
});

test('admission, discovery and both subject reads share one deadline', async () => {
  const digest = textContributionDigest({ work, language, actingSubject: author, body });
  const triples = receiptTriples(digest);
  const cancelled = new AbortController();
  cancelled.abort();
  const idle = environment('', triples, () => { throw new Error('queried after cancellation'); });
  await expect(readOriginalContributionCreateSource(idle.env, contribution, currentWorkAdmission(idle.env),
    { signal: cancelled.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
  expect(idle.seen).toHaveLength(0);

  const duringAdmission = new AbortController();
  const admitted = environment('', triples, sparql => {
    if (sparql.includes('schema:CreativeWork')) duringAdmission.abort();
  });
  await expect(readOriginalContributionCreateSource(admitted.env, contribution,
    currentWorkAdmission(admitted.env), { signal: duringAdmission.signal }))
    .rejects.toBeInstanceOf(ContributionReadExpired);
  expect(admitted.seen).toHaveLength(1);
  expect(admitted.seen[0]!.sparql).toContain('schema:CreativeWork');

  const deadlines: { duration: number; controller: AbortController }[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
    const controller = new AbortController();
    deadlines.push({ duration, controller });
    return controller.signal;
  });
  try {
    const opened = environment('', [...triples, ...anchorTriples('ab'.repeat(32))], sparql => {
      if (sparql.includes(`<${revision}> ?p ?o`)) deadlines[0]!.controller.abort();
    });
    await expect(readOriginalContributionCreateSource(opened.env, contribution, currentWorkAdmission(opened.env)))
      .rejects.toBeInstanceOf(ContributionReadExpired);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]!.duration).toBe(CONTRIBUTION_CREATE_READ_COST.deadlineMs);
    expect(opened.seen.map(query => query.sparql.includes('schema:CreativeWork')
      || query.sparql.includes('SELECT ?receipt')
      || query.sparql.includes('?p ?o'))).toEqual([true, true, true, true]);
  } finally { timeout.mockRestore(); }
});

test('the original create read reserves the admission probe plus its three graph reads', async () => {
  await withDirectory(async directory => {
    const files = store(directory);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const triples = [...receiptTriples(digest), ...anchorTriples(files.manifestDigest)];
    const bodies: string[] = [];
    const transport = spyOn(globalThis, 'fetch').mockImplementation(asFetch(async (_url, init) => {
      const sparql = String(init?.body ?? '');
      bodies.push(sparql);
      const result = sparql.includes('ASK') ? { boolean: true } : evaluate(sparql, triples);
      const payload = Buffer.from(JSON.stringify(result));
      return new Response(payload, { headers: { 'content-type': 'application/sparql-results+json',
        'content-length': String(payload.length) } });
    }));
    try {
      const parent = { signal: new AbortController().signal, callsLeft: 4, bytesLeft: 200_000 };
      const env = { fuseki: new FusekiClient('http://contribution-source.invalid/'),
        objectDirectory: directory } as WorkActivationEnvironment;
      const source = await fusekiReadBudget.run(parent, () => readOriginalContributionCreateSource(
        env, contribution, currentWorkAdmission(env)));
      expect(source.language).toBe(language);
      expect(bodies).toHaveLength(4);
      expect(parent.callsLeft).toBe(0);
      const short = { signal: new AbortController().signal, callsLeft: 3, bytesLeft: 200_000 };
      await expect(fusekiReadBudget.run(short, () => readOriginalContributionCreateSource(
        env, contribution, currentWorkAdmission(env)))).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    } finally { transport.mockRestore(); }
  });
});

function anchorRow(manifestDigest: string, overrides: Record<string, string> = {}) {
  const values = { component: contribution, manifest: `urn:rezics:sha256:${manifestDigest}`,
    model: CONTRIBUTION_PROFILE, shape: CONTRIBUTION_PROFILE, dataset, epoch, sequence, ...overrides };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, term(value)]));
}

function exactRespond(anchor: Record<string, { value: string }>, triples: readonly Triple[]) {
  const subjects = [...new Set(triples.filter(item => item.graph === GRAPHS.receipts).map(item => item.subject))];
  return (sparql: string) => {
    if (sparql.includes('ASK')) return { boolean: true };
    if (sparql.includes('SELECT ?receipt')) {
      return { results: { bindings: subjects.map(receipt => ({ receipt: uri(receipt) })) } };
    }
    if (sparql.includes('SELECT ?p ?o')) {
      return { results: { bindings: triples.filter(item => item.graph === GRAPHS.receipts)
        .map(item => ({ p: uri(item.predicate), o: item.object })) } };
    }
    return { results: { bindings: [anchor] } };
  };
}

function projection(directory: string, respond: (sparql: string) => { results?: { bindings: Record<string, { value: string }>[] }; boolean?: boolean },
  onQuery?: (sparql: string) => void) {
  const seen: { sparql: string; max?: number }[] = [];
  const env = { fuseki: { query: async (sparql: string, max?: number) => {
    seen.push({ sparql, max });
    onQuery?.(sparql);
    return respond(sparql);
  } }, objectDirectory: directory } as unknown as WorkActivationEnvironment;
  return { env, seen };
}

test('exact draft history stays authorized, bounded, and able to read an edited revision', async () => {
  const hidden = projection('', () => { throw new Error('queried before authorization'); });
  await expect(readExactContributionDraft(hidden.env, contribution, revision, async () => false))
    .rejects.toBeInstanceOf(RevisionNotFound);
  expect(hidden.seen).toHaveLength(0);

  const ambiguous = projection('', () => ({ results: { bindings: [anchorRow('ab'.repeat(32)), anchorRow('cd'.repeat(32))] } }));
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
    const editAdmission = randomUUID();
    const editDigest = textContributionEditDigest({ contribution, expectedHead: revision,
      actingSubject: author, body: edited });
    const triples = receiptTriples(editDigest, [], {
      [`${RV}admissionId`]: plain(editAdmission),
      [`${RV}admittedScope`]: plain(`contribution:edit:${contribution}`),
      [`${RV}draftRevision`]: uri(currentHead),
      [`${RV}expectedHead`]: uri(revision),
    }, textContributionEditReceiptIri(editAdmission));
    const { env, seen } = projection(directory, exactRespond(row, triples));
    const draft = await readExactContributionDraft(env, contribution, currentHead, async () => true);
    expect(draft).toMatchObject({ body: edited, predecessor: revision, author, language,
      sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence } });
    expect(seen.some(query => query.sparql.includes('rv:OperationReceipt'))).toBe(true);
    const identityAt = seen.findIndex(query => query.sparql.includes('ASK') && query.sparql.includes('rv:author'));
    const receiptAt = seen.findIndex(query => query.sparql.includes('SELECT ?receipt'));
    expect(receiptAt).toBeGreaterThan(identityAt);
    expect(seen.some(query => query.sparql.includes('ASK'))).toBe(true);

    const budget: RevisionReadBudget = { bytesLeft: 1, signal: new AbortController().signal };
    const exhausted = projection(directory, sparql => {
      if (sparql.includes('ASK')) throw new Error('identity query after byte exhaustion');
      return { results: { bindings: [row] } };
    });
    await expect(readExactContributionDraft(exhausted.env, contribution, currentHead, async () => true, { budget }))
      .rejects.toBeInstanceOf(RevisionReadBudgetExceeded);
    expect(exhausted.seen).toHaveLength(1);

    const expired = new AbortController();
    const late = projection(directory, sparql => {
      if (sparql.includes('ASK')) throw new Error('identity query after expiry');
      expired.abort();
      return { results: { bindings: [row] } };
    });
    await expect(readExactContributionDraft(late.env, contribution, currentHead, async () => true,
      { signal: expired.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
    expect(late.seen).toHaveLength(1);
  });
});

test('exact draft GET composes one current-work admission and the head receipt reads on one deadline', async () => {
  await withDirectory(async directory => {
    const files = store(directory, { work, author, language, body, publication: 'draft' });
    const row = anchorRow(files.manifestDigest);
    const early = new AbortController();
    early.abort();
    const idle = projection(directory, () => { throw new Error('queried after cancellation'); });
    await expect(readExactContributionDraft(idle.env, contribution, revision, currentWorkAdmission(idle.env),
      { signal: early.signal })).rejects.toBeInstanceOf(ContributionReadExpired);
    expect(idle.seen).toHaveLength(0);

    const duringAdmission = new AbortController();
    const admitted = projection(directory, sparql => {
      if (sparql.includes('schema:CreativeWork')) duringAdmission.abort();
      return sparql.includes('ASK') ? { boolean: true } : { results: { bindings: [row] } };
    });
    await expect(readExactContributionDraft(admitted.env, contribution, revision,
      currentWorkAdmission(admitted.env), { signal: duringAdmission.signal }))
      .rejects.toBeInstanceOf(ContributionReadExpired);
    expect(admitted.seen).toHaveLength(1);

    const deadlines: { duration: number; controller: AbortController }[] = [];
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
      const controller = new AbortController();
      deadlines.push({ duration, controller });
      return controller.signal;
    });
    try {
      const opened = projection(directory, sparql => {
        if (sparql.includes('rv:author')) deadlines[0]!.controller.abort();
        return sparql.includes('ASK') ? { boolean: true } : { results: { bindings: [row] } };
      });
      await expect(readExactContributionDraft(opened.env, contribution, revision, currentWorkAdmission(opened.env)))
        .rejects.toBeInstanceOf(ContributionReadExpired);
      expect(deadlines).toHaveLength(1);
      expect(deadlines[0]!.duration).toBe(CONTRIBUTION_CREATE_READ_COST.deadlineMs);
      expect(opened.seen[0]!.sparql).toContain('schema:CreativeWork');
      expect(opened.seen[0]!.max).toBeUndefined();
      expect(opened.seen[1]!.sparql).toContain('LIMIT 2');
      expect(opened.seen[1]!.max).toBe(CONTRIBUTION_CREATE_READ_COST.responseBytes);
      expect(opened.seen[2]!.sparql).toContain('rv:author');
      expect(opened.seen).toHaveLength(3);
    } finally { timeout.mockRestore(); }

    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const receipt = textContributionReceiptIri(admission);
    const triples = receiptTriples(digest);
    const bodies: string[] = [];
    const transport = spyOn(globalThis, 'fetch').mockImplementation(asFetch(async (_url, init) => {
      const sparql = String(init?.body ?? '');
      bodies.push(sparql);
      const result = sparql.includes('SELECT ?receipt')
        ? { results: { bindings: [{ receipt: uri(receipt) }] } }
        : sparql.includes('SELECT ?p ?o')
          ? { results: { bindings: triples.map(item => ({ p: uri(item.predicate), o: item.object })) } }
          : sparql.includes('rv:RevisionAnchor')
            ? { results: { bindings: [row] } }
            : { boolean: true };
      const payload = Buffer.from(JSON.stringify(result));
      return new Response(payload, { headers: { 'content-type': 'application/sparql-results+json',
        'content-length': String(payload.length) } });
    }));
    try {
      const parent = { signal: new AbortController().signal, callsLeft: 5, bytesLeft: 200_000 };
      const env = { fuseki: new FusekiClient('http://contribution-draft.invalid/'),
        objectDirectory: directory } as WorkActivationEnvironment;
      const draft = await fusekiReadBudget.run(parent, () => readExactContributionDraft(
        env, contribution, revision, currentWorkAdmission(env)));
      expect(draft.body).toBe(body);
      expect(draft.language).toBe(language);
      expect(bodies).toHaveLength(5);
      expect(parent.callsLeft).toBe(0);
      const short = { signal: new AbortController().signal, callsLeft: 4, bytesLeft: 200_000 };
      await expect(fusekiReadBudget.run(short, () => readExactContributionDraft(
        env, contribution, revision, currentWorkAdmission(env)))).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    } finally { transport.mockRestore(); }
  });
});

test('exact draft refuses a forged edit digest, a different editor without an Access row, and a removed create receipt', async () => {
  await withDirectory(async directory => {
    const edited = '改稿';
    const files = store(directory, { work, author, language, body: edited, publication: 'draft' });
    const row = anchorRow(files.manifestDigest);
    row.predecessor = term(revision);
    const forged = receiptTriples('0'.repeat(64), [], {
      [`${RV}admittedScope`]: plain(`contribution:edit:${contribution}`),
      [`${RV}draftRevision`]: uri(currentHead),
      [`${RV}expectedHead`]: uri(revision),
    }, textContributionEditReceiptIri(admission));
    const forgedHead = projection(directory, exactRespond(row, forged));
    await expect(readExactContributionDraft(forgedHead.env, contribution, currentHead, async () => true))
      .rejects.toBeInstanceOf(RevisionCorrupt);

    const other = randomUUID();
    const editorDigest = textContributionEditDigest({ contribution, expectedHead: revision,
      actingSubject: editor, body: edited });
    const mismatched = receiptTriples(editorDigest, [], {
      [`${RV}admissionId`]: plain(other),
      [`${RV}admittedScope`]: plain(`contribution:edit:${contribution}`),
      [`${RV}draftRevision`]: uri(currentHead),
      [`${RV}expectedHead`]: uri(revision),
    }, textContributionEditReceiptIri(other));
    const otherEditor = projection(directory, exactRespond(row, mismatched));
    await expect(readExactContributionDraft(otherEditor.env, contribution, currentHead, async () => true))
      .rejects.toBeInstanceOf(RevisionCorrupt);

    const createFiles = store(directory);
    const missing = projection(directory, exactRespond(anchorRow(createFiles.manifestDigest), []));
    await expect(readExactContributionDraft(missing.env, contribution, revision, async () => true))
      .rejects.toBeInstanceOf(RevisionCorrupt);
  });
});

test('original edit source reconciles one edit receipt with its predecessor and actor', async () => {
  await withDirectory(async directory => {
    const edited = '改稿';
    const files = store(directory, { work, author, language, body: edited, publication: 'draft' });
    const editAdmission = randomUUID();
    const digest = textContributionEditDigest({ contribution, expectedHead: revision,
      actingSubject: author, body: edited });
    const receiptObjects = {
      [`${RV}admissionId`]: plain(editAdmission),
      [`${RV}admittedScope`]: plain(`contribution:edit:${contribution}`),
      [`${RV}draftRevision`]: uri(currentHead),
      [`${RV}expectedHead`]: uri(revision),
    };
    const anchorObjects = { [`${RV}predecessor`]: uri(revision) };
    const triples = [...receiptTriples(digest, [], receiptObjects, textContributionEditReceiptIri(editAdmission)),
      ...anchorTriples(files.manifestDigest, [], anchorObjects, currentHead)];
    const { env, seen } = environment(directory, triples);
    const source = await readOriginalContributionEditSource(env, contribution, currentHead, async () => true);
    expect(source).toMatchObject({ contribution, revision: currentHead, work, author, language, body: edited,
      predecessor: revision, expectedHead: revision, actor: author,
      receipt: textContributionEditReceiptIri(editAdmission), requestDigest: digest, admissionId: editAdmission,
      scope: `contribution:edit:${contribution}`,
      sourcePosition: { datasetId: 'product', dataEpoch: epoch, sequence } });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.sparql).toContain('SELECT ?receipt');
    expect(seen[0]!.sparql).toContain('LIMIT 2');
    expect(seen[1]!.sparql).toContain('LIMIT 17');
    expect(seen[2]!.sparql).toContain('LIMIT 11');

    const forged = environment(directory, [
      ...receiptTriples('0'.repeat(64), [], receiptObjects, textContributionEditReceiptIri(editAdmission)),
      ...anchorTriples(files.manifestDigest, [], anchorObjects, currentHead)]);
    await expect(readOriginalContributionEditSource(forged.env, contribution, currentHead, async () => true))
      .rejects.toBeInstanceOf(RevisionCorrupt);
    const gone = environment(directory, anchorTriples(files.manifestDigest, [], anchorObjects, currentHead));
    await expect(readOriginalContributionEditSource(gone.env, contribution, currentHead, async () => true))
      .rejects.toBeInstanceOf(RevisionNotFound);
  });
});
