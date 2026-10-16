import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { CONTENT_REBUILD_PAGE, CONTENT_REBUILD_READ_BUDGET_MS, ContentRebuildUnavailable,
  contentRebuildFailureLine, verifyQuarantinedContentIndex }
  from '../src/modules/content-publication/rebuild.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { startSearchFuseki } from '../../../scripts/operations/search-startup.ts';

const graphEpoch = '11111111-1111-4111-8111-111111111111';
const sourceEpoch = '22222222-2222-4222-8222-222222222222';
const generation = 'urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const binding = (value: string, language?: string) => ({ type: language ? 'literal' : 'uri',
  value, ...(language ? { 'xml:lang': language } : {}) });
const literal = (value: string) => ({ type: 'literal', value });
const integer = (value: string) => ({ type: 'literal', value, datatype: XSD_INTEGER });

type ProofField = readonly [string, string | undefined, 'uri' | 'literal'];
type ProofRow = Record<string, { type: string; value: string }>;
type ReceiptTriple = readonly [string, string, string];
const receiptPredicates: Record<string, string> = {
  rOutcome: 'outcome', rReason: 'reason', rRequestDigest: 'requestDigest',
  rAdmissionId: 'admissionId', rAuthorityEpoch: 'authorityEpoch', rScope: 'admittedScope',
  rActor: 'actingSubject', rPreparation: 'contentPreparation', rRevision: 'contentRevision',
  rVariant: 'variant', rResource: 'resource', rByteDigest: 'byteDigest',
  rOwnerEpoch: 'ownerDataEpoch', rOwnerSequence: 'ownerSequence', rExpectedHead: 'expectedHead',
  rDataset: 'datasetId', rDataEpoch: 'dataEpoch', rSequence: 'sequence',
  rDecision: 'publicationDecision', rPublication: 'publicationDecision',
  rRightsBasis: 'rightsBasis', rAssessment: 'rightsAssessment', rDisclosure: 'disclosure',
  rEligibility: 'eligibilityDecision',
};

function optionalGroups(sparql: string): string[][] {
  const tokens = sparql.match(/#[^\n]*|<[^>]*>|"(?:\\.|[^"\\])*"|\?[\w]+|[\w:-]+|[^\s]/g) ?? [];
  const starts: number[] = [], groups: { start: number; tokens: string[] }[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.startsWith('#')) continue;
    if (token === '{') starts.push(index);
    else if (token === '}') {
      const start = starts.pop();
      if (start === undefined) throw new Error('Unbalanced query group');
      if (tokens[start - 1] === 'OPTIONAL') groups.push({ start, tokens: tokens.slice(start + 1, index) });
    }
  }
  if (starts.length) throw new Error('Unbalanced query group');
  return groups.sort((left, right) => left.start - right.start).map(group => group.tokens);
}

function receiptTriples(group: readonly string[]): ReceiptTriple[] {
  const triples: ReceiptTriple[] = [];
  for (let index = 0; index < group.length; index++) {
    if (group[index] !== 'GRAPH' || group[index + 1] !== '<urn:rezics:graph:receipts>') continue;
    if (group[index + 2] !== '{') throw new Error('Missing receipt graph group');
    index += 3;
    while (group[index] !== '}') {
      const subject = group[index++]!;
      do {
        const predicate = group[index++]!, object = group[index++]!;
        triples.push([subject, predicate, object]);
        if (group[index] !== ';') break;
        index++;
      } while (index < group.length);
      if (group[index] === '.') index++;
      if (index >= group.length) throw new Error('Unclosed receipt graph group');
    }
  }
  return triples;
}

function assertReceiptJoinsBound(query: string, kind: 'publication' | 'eligibility'): void {
  const groups = optionalGroups(query).filter(group => group.includes('?receipt'));
  expect(groups.length).toBeGreaterThan(2);
  for (const group of groups) {
    expect(receiptTriples(group)).toContainEqual(['?receipt', `rv:${kind}Decision`, `?${kind}`]);
  }
}

// Evaluate the emitted receipt GRAPH patterns as sequential OPTIONAL joins.
// Receipts form a separate graph: a VALUES decision does not invent its receipt.
function joinReceiptProofs(query: string, kind: 'publication' | 'eligibility', allRows: ProofRow[],
  missingReceipt: FixtureOptions['missingReceipt'], joinedReceipts: string[]): ProofRow[] {
  const groups = optionalGroups(query).filter(group => group.includes('?receipt'));
  const graph = allRows.filter((_, index) => missingReceipt?.kind !== kind || missingReceipt.index !== index)
    .map(row => {
      const facts = new Map<string, ProofRow[string]>([
        ['a', binding(`${RV}OperationReceipt`)], [`rv:${kind}Decision`, row[kind]!],
      ]);
      for (const [field, predicate] of Object.entries(receiptPredicates)) {
        if (row[field]) facts.set(`rv:${predicate}`, row[field]!);
      }
      return { receipt: row.receipt!, facts };
    });
  const asked = valuesIds(query, kind);
  return allRows.filter(row => asked.includes(row[kind]!.value)).map(row => {
    let solutions: ProofRow[] = [{ [kind]: row[kind]! }];
    for (const group of groups) {
      const triples = receiptTriples(group);
      solutions = solutions.flatMap(solution => {
        const matches = graph.flatMap(({ receipt, facts }) => {
          const next = { ...solution };
          for (const [subject, predicate, object] of triples) {
            const fact = facts.get(predicate);
            if (!fact || subject !== '?receipt') return [];
            if (next.receipt && next.receipt.value !== receipt.value) return [];
            next.receipt = receipt;
            if (object.startsWith('?')) {
              const variable = object.slice(1);
              if (next[variable] && JSON.stringify(next[variable]) !== JSON.stringify(fact)) return [];
              next[variable] = fact;
            } else if (fact.value !== (object === 'rv:Succeeded' ? `${RV}Succeeded`
              : object === 'rv:OperationReceipt' ? `${RV}OperationReceipt` : object)) return [];
          }
          if (group.includes('?receiptType')) next.receiptType = integer('1');
          joinedReceipts.push(receipt.value);
          return [next];
        });
        return matches.length ? matches : [solution];
      });
    }
    const result = { ...row };
    for (const variable of ['receipt', 'receiptType', ...Object.keys(row).filter(key => /^r[A-Z]/.test(key)
      && !key.endsWith('Count'))]) {
      const values = new Map(solutions.flatMap(solution => solution[variable]
        ? [[JSON.stringify(solution[variable]), solution[variable]!] as const] : []));
      result[`${variable}Count`] = integer(String(values.size));
      const value = values.values().next().value;
      if (value) result[variable] = value;
      else delete result[variable];
    }
    return result;
  });
}

function proofRow(idField: 'publication' | 'eligibility', id: string, receipt: string,
  fields: readonly ProofField[]) {
  const row: Record<string, { type: string; value: string }> = {
    [idField]: binding(id), decisionTypeCount: integer('1'), anchorTypeCount: integer('1'),
    receiptCount: integer('1'), receipt: binding(receipt), receiptTypeCount: integer('1'),
  };
  for (const [name, value, kind] of fields) {
    row[`${name}Count`] = integer(value === undefined ? '0' : '1');
    if (value !== undefined) row[name] = kind === 'uri' ? binding(value)
      : name === 'dSequence' || name === 'rSequence' ? integer(value) : literal(value);
  }
  return row;
}

function valuesIds(sparql: string, variable: string): string[] {
  const pattern = new RegExp(`VALUES \\?${variable} \\{([^}]*)\\}`);
  return [...(sparql.match(pattern)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
}

function variantId(index: number): string {
  return `urn:rezics:variant:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function revisionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function afterLiteral(sparql: string, variable: string): string {
  const match = sparql.match(new RegExp(`FILTER\\(STR\\(\\?${variable}\\) > (".*")\\)`));
  return match ? JSON.parse(match[1]!) as string : '';
}

function page<T extends { id: string }>(items: readonly T[], after: string): T[] {
  return items.filter(item => item.id > after)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, CONTENT_REBUILD_PAGE);
}

interface FixtureOptions {
  count?: number;
  missingHead?: number;
  population?: string;
  timeoutOn?: string;
  missingReceipt?: { kind: 'publication' | 'eligibility'; index: number };
  unrelatedReceipt?: boolean;
}

function verifyFixture(options: FixtureOptions = {}) {
  const count = options.count ?? 1;
  const records = Array.from({ length: count + (options.unrelatedReceipt ? 1 : 0) }, (_, index) => {
    const variant = variantId(index);
    const revision = `urn:rezics:content:revision:${revisionId(index)}`;
    const publicationAdmissionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const eligibilityAdmissionId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const resource = `https://rezics.com/id/${revisionId(index)}`;
    const decision = contentPublicationDecisionIri(publicationAdmissionId);
    const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmissionId);
    const actor = 'urn:rezics:subject:content-rebuild-fixture';
    const eligibilityDigest = contentSearchEligibilityDigest({ resourceId: resource, variantId: variant,
      publicationDecision: decision, expectedEligibilityHead: null, actingSubject: actor,
      rightsBasis: 'original-contribution', disclosure: 'public' });
    return { id: variant, variant, resource: `https://rezics.com/id/${revisionId(index)}`,
      revision, revisionId: revisionId(index), publicationAdmissionId, eligibilityAdmissionId,
      publicationReceipt: contentPublicationReceiptIri(publicationAdmissionId),
      eligibilityDigest, eligibilityReceipt: contentSearchEligibilityReceiptIri(eligibilityAdmissionId),
      decision, eligibility, actor,
      unit: `urn:rezics:content:match-unit:${String(index).padStart(64, '0')}`,
      digest: 'd'.repeat(64), text: `body ${index}` };
  });
  const queries: string[] = [];
  const joinedReceipts: string[] = [];
  const proofRows: { kind: 'publication' | 'eligibility'; rows: ProofRow[] }[] = [];
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    queries.push(sparql);
    if (options.timeoutOn && sparql.includes(options.timeoutOn)) {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:public>')) return { boolean: false };
    if (sparql.includes('ASK { GRAPH <urn:rezics:graph:receipts>')) return { boolean: true };
    if (sparql.includes('SELECT ?epoch ?routing')) return { results: { bindings: [{
      epoch: binding(graphEpoch), routing: binding(graphEpoch), sequence: integer('3'),
      generation: binding(generation),
    }] } };
    if (sparql.includes('COUNT(DISTINCT ?resource) AS ?resourceCount')) {
      const rows = page(records.slice(0, count), afterLiteral(sparql, 'variant'));
      return { results: { bindings: rows.map(row => {
        const hasEligibilityHead = row.id !== variantId(options.missingHead ?? -1);
        return { variant: binding(row.variant), resourceCount: integer('1'), resource: binding(row.resource),
          publicationCount: integer('1'), publication: binding(row.decision),
          eligibilityCount: integer(hasEligibilityHead ? '1' : '0'),
          ...(hasEligibilityHead ? { eligibility: binding(row.eligibility) } : {}) };
      }) } };
    }
    if (sparql.includes('SELECT ?eligibility')) {
      const allRows = records.map(row => proofRow('eligibility', row.eligibility,
        row.eligibilityReceipt, [
          ['dComponent', row.variant, 'uri'], ['dVariant', row.variant, 'uri'],
          ['dResource', row.resource, 'uri'], ['dPublication', row.decision, 'uri'],
          ['dRightsBasis', `${RV}OriginalContribution`, 'uri'], ['dAssessment', undefined, 'uri'],
          ['dDisclosure', `${RV}Public`, 'uri'], ['dAdmissionId', row.eligibilityAdmissionId, 'literal'],
          ['dAuthorityEpoch', '1', 'literal'], ['dScope', `content:search-eligibility:${row.variant}`, 'literal'],
          ['dActor', row.actor, 'uri'],
          ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
          ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
          ['dDataset', DATASET, 'uri'], ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '2', 'literal'],
          ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
          ['rRequestDigest', row.eligibilityDigest, 'literal'],
          ['rAdmissionId', row.eligibilityAdmissionId, 'literal'], ['rAuthorityEpoch', '1', 'literal'],
          ['rScope', `content:search-eligibility:${row.variant}`, 'literal'], ['rActor', row.actor, 'uri'],
          ['rResource', row.resource, 'uri'], ['rVariant', row.variant, 'uri'],
          ['rPublication', row.decision, 'uri'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
          ['rRightsBasis', `${RV}OriginalContribution`, 'uri'], ['rAssessment', undefined, 'uri'],
          ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
          ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '2', 'literal'],
          ['rEligibility', row.eligibility, 'uri'],
        ]));
      const rows = joinReceiptProofs(sparql, 'eligibility', allRows, options.missingReceipt, joinedReceipts);
      proofRows.push({ kind: 'eligibility', rows });
      return { results: { bindings: rows } };
    }
    if (sparql.includes('SELECT ?publication')) {
      const allRows = records.map(row => proofRow('publication', row.decision,
        row.publicationReceipt, [
          ['dComponent', row.variant, 'uri'], ['dResource', row.resource, 'uri'],
          ['dRevision', row.revision, 'uri'], ['dDigest', row.digest, 'literal'],
          ['dOwnerEpoch', sourceEpoch, 'literal'], ['dOwnerSequence', '3', 'literal'],
          ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '1', 'literal'],
          ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
          ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
          ['dDataset', DATASET, 'uri'], ['dPreparation', `fixture-preparation-${row.revisionId}`, 'literal'],
          ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
          ['rRequestDigest', 'a'.repeat(64), 'literal'],
          ['rAdmissionId', row.publicationAdmissionId, 'literal'], ['rAuthorityEpoch', '1', 'literal'],
          ['rScope', `content:publish:${row.variant}`, 'literal'],
          ['rPreparation', `fixture-preparation-${row.revisionId}`, 'literal'],
          ['rRevision', row.revision, 'uri'], ['rVariant', row.variant, 'uri'],
          ['rResource', row.resource, 'uri'], ['rByteDigest', row.digest, 'literal'],
          ['rOwnerEpoch', sourceEpoch, 'literal'], ['rOwnerSequence', '3', 'literal'],
          ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rDataset', DATASET, 'uri'],
          ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '1', 'literal'],
          ['rDecision', row.decision, 'uri'],
        ]));
      const rows = joinReceiptProofs(sparql, 'publication', allRows, options.missingReceipt, joinedReceipts);
      proofRows.push({ kind: 'publication', rows });
      return { results: { bindings: rows } };
    }
    if (sparql.includes('SELECT ?unit ?body')) {
      const rows = page(records.slice(0, count).map(row => ({ ...row, id: row.unit })), afterLiteral(sparql, 'unit'));
      return { results: { bindings: rows.map(row => ({ unit: binding(row.unit), body: binding(row.text, 'en'),
        resource: binding(row.resource), variant: binding(row.variant), revision: binding(row.revision),
        decision: binding(row.decision), eligibility: binding(row.eligibility) })) } };
    }
    if (sparql.includes('publicTextInventory()')) {
      return { results: { bindings: [{ population: binding(options.population ?? String(count)) }] } };
    }
    if (sparql.includes('ASK { GRAPH <urn:rezics:search:probe>')) return { boolean: true };
    throw new Error(`unexpected rebuild query: ${sparql.slice(0, 160)}`);
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const position = { owner: 'content' as const, dataEpoch: sourceEpoch, sequence: '3' };
  const content = { ownerPosition: async () => position,
    readExactBatch: async (ids: string[]) => ids.map(id => {
      const record = records.find(item => item.revisionId === id)!;
      return { status: 'available' as const, reference: { variantId: record.variant,
        resourceId: record.resource, byteDigest: record.digest, model: 'content-shape-v1',
        language: { kind: 'tag' as const, tag: 'en' } }, body: { body: record.text } };
    }),
  } as unknown as ContentCore;
  const cursor = { read: async () => position } as unknown as ContentProjectionCursor;
  const run = verifyQuarantinedContentIndex({ fuseki,
    lineage: { dataEpoch: graphEpoch, routingEpoch: graphEpoch }, objectDirectory: '' },
  content, cursor, { id: graphEpoch, cut: position, consumer: 'content-rebuild.fixture' });
  return { run, queries, proofRows, joinedReceipts, unrelated: options.unrelatedReceipt ? records.at(-1) : undefined };
}

test('rebuild verification pages variants and binds each receipt join', async () => {
  const count = CONTENT_REBUILD_PAGE + 1;
  const { run, queries } = verifyFixture({ count });
  expect(await run).toMatchObject({ unitCount: count, contentUnitCount: count });
  const candidates = queries.filter(query => query.includes('COUNT(DISTINCT ?resource) AS ?resourceCount'));
  const publicationProofs = queries.filter(query => query.includes('SELECT ?publication')
    && query.includes('urn:rezics:graph:receipts'));
  const eligibilityProofs = queries.filter(query => query.includes('SELECT ?eligibility')
    && query.includes('urn:rezics:graph:receipts'));
  const units = queries.filter(query => query.includes('SELECT ?unit ?body'));
  expect(candidates).toHaveLength(2);
  expect(candidates[1]).toContain('FILTER(STR(?variant) >');
  expect(candidates.every(query => query.includes(`ORDER BY STR(?variant)`)
    && query.includes(`LIMIT ${CONTENT_REBUILD_PAGE}`))).toBe(true);
  expect(publicationProofs).toHaveLength(2);
  expect(eligibilityProofs).toHaveLength(2);
  for (const [proofs, variable, receiptPredicate] of [
    [publicationProofs, 'publication', 'publicationDecision'],
    [eligibilityProofs, 'eligibility', 'eligibilityDecision'],
  ] as const) {
    expect(proofs.map(query => valuesIds(query, variable).length)).toEqual([CONTENT_REBUILD_PAGE, 1]);
    for (const query of proofs) {
      expect(query).toContain(`VALUES ?${variable}`);
      assertReceiptJoinsBound(query, variable);
      const receiptGroups = optionalGroups(query).filter(group => group.includes('?receipt'));
      const receiptBinding = receiptTriples(receiptGroups[0]!);
      expect(receiptBinding).toContainEqual(['?receipt', `rv:${receiptPredicate}`, `?${variable}`]);
      if (variable === 'publication') {
        // Inventory every claimant before validating its fields, including a
        // malformed duplicate. Eligibility receipts have no preparation.
        expect(receiptBinding).toContainEqual(['?receipt', 'rv:contentPreparation', '?publicationPreparation']);
        const proofTriples = receiptGroups.flatMap(receiptTriples);
        expect(proofTriples).toContainEqual(['?receipt', 'a', 'rv:OperationReceipt']);
        expect(proofTriples).toContainEqual(['?receipt', 'rv:outcome', '?rOutcome']);
        expect(proofTriples).toContainEqual(['?receipt', 'rv:contentRevision', '?rRevision']);
      }
      expect(query).not.toContain(`LIMIT ${50_001}`);
    }
  }
  expect(units).toHaveLength(2);
  expect(units.every(query => query.includes('ORDER BY STR(?unit)')
    && query.includes(`LIMIT ${CONTENT_REBUILD_PAGE}`))).toBe(true);
  expect(queries.some(query => query.includes('urn:rezics:graph:revisions')
    && !query.includes('VALUES ?publication') && !query.includes('VALUES ?eligibility'))).toBe(false);
  expect(CONTENT_REBUILD_READ_BUDGET_MS).toBeLessThan(10_000);
});

for (const kind of ['publication', 'eligibility'] as const) {
  test(`a missing ${kind} receipt cannot join unrelated receipts`, async () => {
    const fixture = verifyFixture({ missingReceipt: { kind, index: 0 }, unrelatedReceipt: true });
    await expect(fixture.run).rejects.toThrow(ContentRebuildUnavailable);
    const rows = fixture.proofRows.find(proof => proof.kind === kind)!.rows;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.receiptCount).toEqual(integer('0'));
    expect(row.receiptTypeCount).toEqual(integer('0'));
    expect(row.receipt).toBeUndefined();
    for (const [field, value] of Object.entries(row).filter(([field]) => /^r[A-Z]/.test(field))) {
      expect(field.endsWith('Count')).toBe(true);
      expect(value).toEqual(integer('0'));
    }
    expect(fixture.joinedReceipts).not.toContain(fixture.unrelated!.publicationReceipt);
    expect(fixture.joinedReceipts).not.toContain(fixture.unrelated!.eligibilityReceipt);
    for (const query of fixture.queries.filter(query => query.includes(`SELECT ?${kind}`))) {
      assertReceiptJoinsBound(query, kind);
    }
  });
}

test('a variant with no public head still fails the rebuild', async () => {
  const { run } = verifyFixture({ missingHead: 0 });
  await expect(run).rejects.toThrow(ContentRebuildUnavailable);
  await expect(verifyFixture({ missingHead: 0 }).run).rejects.toThrow(
    'Content MatchUnit remains for a closed publication');
});

test('a timed out verification read names its step and page', async () => {
  const timedOut = (label: string) => new RegExp(`${label}: timed out after \\d+ms \\(budget 8000ms\\)`);
  await expect(verifyFixture({ timeoutOn: 'COUNT(DISTINCT ?resource) AS ?resourceCount' }).run)
    .rejects.toThrow(timedOut('verify: eligibility candidate page 0'));
  await expect(verifyFixture({ timeoutOn: 'SELECT ?eligibility' }).run)
    .rejects.toThrow(timedOut('verify: eligibility eligibility owner records'));
  await expect(verifyFixture({ timeoutOn: 'SELECT ?unit ?body' }).run)
    .rejects.toThrow(timedOut('verify: units page 0'));
  await expect(verifyFixture({ timeoutOn: 'publicTextInventory()' }).run)
    .rejects.toThrow(timedOut('verify: inventory'));
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  expect(contentRebuildFailureLine(timeout)).toBe('rebuild: timed out');
  const named = 'verify: heads page 0: timed out after 4ms (budget 8000ms)';
  expect(contentRebuildFailureLine(new ContentRebuildUnavailable(named))).toBe(named);
});

test('every content rebuild read has one unique label', () => {
  const source = readFileSync(new URL('../src/modules/content-publication/rebuild.ts', import.meta.url), 'utf8');
  const calls = source.match(/readContentRebuildStep\(/g) ?? [];
  const labels = [...source.matchAll(/readContentRebuildStep\(\s*(?:'([^']*)'|`([^`]*)`)/g)]
    .map(match => match[1] ?? match[2] ?? '');
  expect(labels).toHaveLength(calls.length);
  expect(labels.every(label => label.length > 0)).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
  for (const label of ['progress: anchor', 'progress: quarantine receipt', 'progress: cleared receipt',
    'progress: content units', 'progress: malformed content', 'progress: index control',
    'progress: offline receipt', 'progress: activation receipt', 'adopt: quarantine job',
    'clear: page ${page}']) {
    expect(labels).toContain(label);
  }
  expect(source).not.toContain('ORDER BY DESC');
  expect(source).not.toContain("readContentRebuildStep('rebuild command'");
});

test('a Fuseki startup timeout names the wait', async () => {
  const error = new Error('spawnSync docker ETIMEDOUT');
  await expect(startSearchFuseki(import.meta.dir, process.env, 'dev', () => { throw error; }))
    .rejects.toThrow('startup wait: timed out');
});
