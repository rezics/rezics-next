import { expect, spyOn, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, FusekiQueryResponseTooLarge }
  from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_CREATE_READ_COST, ContributionReadExpired, readTextContributionReceipt,
  textContributionReceiptIri } from '../src/modules/contribution/draft.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const admission = '00000000-0000-4000-8000-000000000021';
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000022';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000023';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000024';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000025';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value, datatype: `${XSD}string` });
const integer = (value: string) => ({ type: 'literal', value, datatype: `${XSD}integer` });

function succeeded(overrides: Record<string, { type: string; value: string; datatype?: string }> = {}) {
  return { outcome: uri(`${RV}Succeeded`), digest: literal('ab'.repeat(32)), id: literal(admission),
    epoch: literal('1'), scope: literal(`contribution:create:${work}`), dataEpoch: literal('epoch-1'),
    sequence: integer('3'), work: uri(work), contribution: uri(contribution),
    draftRevision: uri(revision), language: literal('ja'), author: uri(author), ...overrides };
}

function environment(bindings: Record<string, { type?: string; value: string; datatype?: string }>[], onQuery?: () => void) {
  const seen: { sparql: string; max?: number }[] = [];
  const env = { fuseki: { query: async (sparql: string, max?: number) => {
    seen.push({ sparql, max });
    onQuery?.();
    return { results: { bindings } };
  } } } as unknown as WorkActivationEnvironment;
  return { env, seen };
}

test('original create receipt reads are limited to two rows and a bounded response', async () => {
  const missing = environment([]);
  expect(await readTextContributionReceipt(missing.env, admission)).toBeNull();
  expect(missing.seen[0]!.sparql).toContain('LIMIT 2');
  expect(missing.seen[0]!.max).toBe(CONTRIBUTION_CREATE_READ_COST.responseBytes);

  const found = environment([succeeded()]);
  expect(await readTextContributionReceipt(found.env, admission)).toMatchObject({
    outcome: 'succeeded', receipt: textContributionReceiptIri(admission), admissionId: admission,
    work, author, language: 'ja', contribution, draftRevision: revision, sequence: '3' });

  const cancelledRow = { outcome: uri(`${RV}Cancelled`), digest: literal('cd'.repeat(32)),
    id: literal(admission), epoch: literal('1'), scope: literal(`contribution:create:${work}`),
    dataEpoch: literal('epoch-1'), sequence: integer('2') };
  const cancelled = await readTextContributionReceipt(environment([cancelledRow]).env, admission);
  expect(cancelled).toMatchObject({ outcome: 'cancelled', sequence: '2' });
  expect(cancelled).not.toHaveProperty('author');
  expect(cancelled).not.toHaveProperty('contribution');
  await expect(readTextContributionReceipt(environment([succeeded({ outcome: uri(`${RV}Cancelled`) })]).env, admission))
    .rejects.toThrow('Contribution receipt is incomplete');
  const lexicalWork = succeeded();
  lexicalWork.work = literal(work);
  await expect(readTextContributionReceipt(environment([lexicalWork]).env, admission))
    .rejects.toThrow('Contribution receipt is incomplete');

  const duplicate = environment([succeeded(), succeeded()]);
  await expect(readTextContributionReceipt(duplicate.env, admission))
    .rejects.toThrow('Contribution receipt cardinality violation');
  await expect(readTextContributionReceipt(environment([succeeded({ digest: literal('') })]).env, admission))
    .rejects.toThrow('Contribution receipt is incomplete');
});

test('a create receipt read expires across its await and does not return a stale row', async () => {
  const controller = new AbortController();
  controller.abort();
  const early = environment([succeeded()]);
  await expect(readTextContributionReceipt(early.env, admission, { signal: controller.signal }))
    .rejects.toBeInstanceOf(ContributionReadExpired);
  expect(early.seen).toHaveLength(0);

  const late = new AbortController();
  const expired = environment([succeeded()], () => late.abort());
  await expect(readTextContributionReceipt(expired.env, admission, { signal: late.signal }))
    .rejects.toBeInstanceOf(ContributionReadExpired);
  expect(expired.seen).toHaveLength(1);

  const deadlines: { duration: number; controller: AbortController }[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(duration => {
    const timer = new AbortController();
    deadlines.push({ duration, controller: timer });
    return timer.signal;
  });
  try {
    const shared = environment([succeeded()], () => deadlines[0]!.controller.abort());
    await expect(readTextContributionReceipt(shared.env, admission)).rejects.toBeInstanceOf(ContributionReadExpired);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]!.duration).toBe(CONTRIBUTION_CREATE_READ_COST.deadlineMs);
  } finally { timeout.mockRestore(); }
});

test('the Fuseki client enforces the create receipt response cap and charges the caller budget', async () => {
  const payload = Buffer.from(JSON.stringify({ results: { bindings: [] } }));
  const parent = { signal: new AbortController().signal, callsLeft: 4, bytesLeft: 100_000 };
  const asFetch = (transport: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) =>
    transport as typeof globalThis.fetch;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(asFetch(async (_url, init) => {
    expect(String(init?.body)).toContain('LIMIT 2');
    expect(init?.signal).toBeDefined();
    return new Response(payload, { headers: { 'content-type': 'application/sparql-results+json',
      'content-length': String(payload.length) } });
  }));
  try {
    expect(await fusekiReadBudget.run(parent, () => readTextContributionReceipt(
      { fuseki: new FusekiClient('http://contribution-receipt.invalid/') } as WorkActivationEnvironment,
      admission))).toBeNull();
    expect(parent.callsLeft).toBe(3);
    expect(parent.bytesLeft).toBe(100_000 - payload.length);
  } finally { transport.mockRestore(); }

  const oversized = spyOn(globalThis, 'fetch').mockImplementation(asFetch(async () => new Response(
    Buffer.alloc(8), { headers: { 'content-type': 'application/sparql-results+json',
      'content-length': String(CONTRIBUTION_CREATE_READ_COST.responseBytes + 1) } })));
  try {
    await expect(readTextContributionReceipt(
      { fuseki: new FusekiClient('http://contribution-receipt.invalid/') } as WorkActivationEnvironment,
      admission)).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  } finally { oversized.mockRestore(); }
});
