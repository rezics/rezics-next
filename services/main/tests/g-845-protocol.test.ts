import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Value } from 'typebox/value';
import { WikiExtractionSchema, WikiCandidatesSchema, WikiResourceSchema, wikiRightsBases, type WikiExtraction }
  from '../src/modules/wiki/protocol.ts';
import { rightsBases } from '../src/modules/rights/schema.ts';
import { checkWikiExtraction } from '../src/modules/wiki/validate.ts';
import { evidenceQuotationUses, extractionQuotationUses, quotationKey, quotationPreview,
  WIKI_QUOTATION_POLICY } from '../src/modules/wiki/quotation.ts';
import { WikiRejected } from '../src/modules/wiki/errors.ts';
import { wikiLabel, candidateItems, wikiCandidates, readCandidateNameRecords } from '../src/modules/wiki/candidates.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { PlatformClosed } from '../src/modules/access/exposure.ts';
import { wikiRead, type WikiRead } from '../src/modules/wiki/read.ts';
import { WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const root = resolve(import.meta.dir, '../../..');
const protocol = resolve(root, 'packages/wiki-toolkit/protocol');
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const evidence = (quote = 'She is Elizabeth.', start = 0) => ({ quote, locator: {
  version: 'rezics-locator-v1' as const,
  source: { type: 'external' as const, representationSha256: 'a'.repeat(64), mediaType: 'text/plain' },
  selector: { type: 'ByteRangeSelector' as const, unit: 'byte' as const, start, end: start + 100 },
} });
const bundle = (): WikiExtraction => ({ profile: 'wiki-extraction-v1', target: id(1), zone: id(2), continuity: id(1),
  source: { representationSha256: 'a'.repeat(64), mediaType: 'text/plain', language: 'en', rightsBasis: 'public_domain',
    method: { agent: 'Holder', model: 'Local model', inference: 'local' } },
  units: [{ id: 'chapter-1', ordinal: 1, label: 'Chapter one', occurrence: id(3) }],
  entities: [{ id: 'elizabeth', type: 'https://rezics.com/vocab/Character', names: [{ value: 'Elizabeth', language: 'en',
    kind: 'primary', revealedAt: 'chapter-1' }] }],
  claims: [{ subject: 'elizabeth', predicate: id(4), object: { kind: 'literal', value: 'Bennet' },
    modality: 'narrated', continuity: id(1), revealedAt: 'chapter-1', evidence: [evidence()] }] });

test('G-845: emitted extraction/candidate schemas bound all text and cannot admit a corpus body', () => {
  for (const [file, schema] of [['wiki-extraction', WikiExtractionSchema], ['wiki-candidates', WikiCandidatesSchema]] as const) {
    const emitted = JSON.parse(readFileSync(resolve(protocol, `${file}.schema.json`), 'utf8'));
    const { $schema, $id, $comment, ...wire } = emitted;
    expect($schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect($id).toContain(`${file}-v1`);
    expect($comment).toBe('SPDX-License-Identifier: Apache-2.0');
    expect(wire).toEqual(JSON.parse(JSON.stringify(schema)));
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as Record<string, unknown>;
      if (node.type === 'string') {
        expect(Number.isInteger(node.maxLength)).toBe(true);
        if (!node['x-wiki-iri']) expect(Number(node.maxLength)).toBeLessThanOrEqual(200);
      }
      if (node.type === 'object') expect(node.additionalProperties).toBe(false);
      if (node.type === 'array') expect(Number.isInteger(node.maxItems)).toBe(true);
      Object.values(node).forEach(walk);
    };
    walk(emitted);
  }
  expect(wikiRightsBases).toEqual(rightsBases);
  const valid = bundle();
  expect(Value.Check(WikiExtractionSchema, valid)).toBe(true);
  for (const extra of [{ body: 'Full novel' }, { corpus: 'Full novel' }, { text: 'Full novel' }]) {
    expect(Value.Check(WikiExtractionSchema, { ...valid, ...extra })).toBe(false);
    expect(Value.Check(WikiExtractionSchema, { ...valid, source: { ...valid.source, ...extra } })).toBe(false);
  }
  valid.entities[0]!.names[0]!.value = 'x'.repeat(201);
  expect(Value.Check(WikiExtractionSchema, valid)).toBe(false);
  const hosted = bundle();
  hosted.claims[0]!.evidence[0]!.locator.source = { type: 'hosted', revision: id(1), digest: 'a'.repeat(64) };
  hosted.claims[0]!.evidence[0]!.locator.selector = { type: 'TextQuoteSelector', exact: evidence().quote };
  expect(Value.Check(WikiExtractionSchema, hosted)).toBe(false);
});

test('G-845: Apache protocol imports stay within its package or TypeBox and model keeps the locator API', () => {
  const visit = (directory: string) => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, file.name);
      if (file.isDirectory()) { visit(path); continue; }
      if (!file.name.endsWith('.ts')) continue;
      const source = readFileSync(path, 'utf8');
      expect(source).toStartWith('// SPDX-License-Identifier: Apache-2.0');
      expect(source).not.toMatch(/ContentCommentTarget|locatorFromComment|urn:rezics:content:revision/);
      for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\(|import\s*)['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        expect(specifier === 'typebox' || specifier.startsWith('typebox/')
          || specifier.startsWith('.') && resolve(dirname(path), specifier).startsWith(`${resolve(protocol, '..')}/`)).toBe(true);
      }
      expect(source).not.toMatch(/\b(?:import|require)\s*\(/);
    }
  };
  visit(protocol);
  const manifest = JSON.parse(readFileSync(resolve(protocol, '../package.json'), 'utf8'));
  expect(manifest.license).toBe('Apache-2.0');
  expect(manifest.private).not.toBe(true);
  expect(readFileSync(resolve(protocol, '../LICENSE'), 'utf8')).toContain('Version 2.0, January 2004');
  expect(readFileSync(resolve(root, 'packages/model/src/locator.ts'), 'utf8')).toContain('@rezics/wiki-toolkit/protocol');
  for (const rule of ['no-dynamic-code', 'no-math-random']) {
    expect(readFileSync(resolve(root, `scripts/static/ast-grep/rules/${rule}.yml`), 'utf8'))
      .toContain('packages/wiki-toolkit/**/*.ts');
  }
});

test('G-845: the Apache protocol admits bounded host-independent IRIs while Main requires native identities', async () => {
  const foreign = 'https://wiki.example/作品/Elizabeth';
  for (const value of [foreign, 'urn:example:elizabeth', 'did:example:holder']) {
    expect(Value.Check(WikiResourceSchema, value)).toBe(true);
  }
  for (const value of ['relative/path', 'https://wiki.example/a b', `urn:${'x'.repeat(2048)}`]) {
    expect(Value.Check(WikiResourceSchema, value)).toBe(false);
  }
  const variants = [
    { ...bundle(), target: foreign }, { ...bundle(), zone: foreign }, { ...bundle(), continuity: foreign },
    { ...bundle(), units: [{ ...bundle().units[0]!, occurrence: foreign }] },
    { ...bundle(), entities: [{ ...bundle().entities[0]!, match: foreign }] },
    { ...bundle(), claims: [{ ...bundle().claims[0]!, continuity: foreign }] },
  ];
  for (const value of variants) {
    expect(Value.Check(WikiExtractionSchema, value)).toBe(true);
    expect(() => checkWikiExtraction(value)).toThrow('invalid_wiki_extraction');
  }
  for (const input of [{ target: foreign, zone: id(2) }, { target: id(1), zone: foreign }]) {
    const request = { ...input, names: [{ value: 'Elizabeth', language: 'fr' }] };
    expect(Value.Check(WikiCandidatesSchema, request)).toBe(true);
    await expect(wikiCandidates({} as WikiRead, request)).rejects.toThrow('invalid_wiki_candidates');
  }
});

test('G-845: name-record reads use one complete query with total and per-entity bounds', async () => {
  let queries = 0;
  const session = { query: async (query: string, limit: number) => {
    queries++;
    expect(query).toContain(`VALUES ?resource { <${id(1)}> <${id(2)}> }`);
    expect(query).toContain('SELECT ?resource ?label');
    expect(query).toContain('LIMIT 129');
    expect(limit).toBe(128);
    return [{ resource: { type: 'uri', value: id(1) }, label: { type: 'literal', value: 'Eliza', 'xml:lang': 'en' } },
      { resource: { type: 'uri', value: id(2) }, label: { type: 'literal', value: 'Jane', 'xml:lang': 'fr' } }];
  } };
  expect(await readCandidateNameRecords(session, [id(1), id(2)]))
    .toEqual(new Map([[id(1), ['Eliza']], [id(2), ['Jane']]]));
  expect(queries).toBe(1);
  expect(await readCandidateNameRecords(session, [])).toEqual(new Map());
  expect(queries).toBe(1);
  const skewed = { query: async () => Array.from({ length: 65 }, () => ({
    resource: { type: 'uri', value: id(1) }, label: { type: 'literal', value: 'Alias' } })) };
  await expect(readCandidateNameRecords(skewed, [id(1), id(2)])).rejects.toThrow('wiki_query_budget');
  await expect(readCandidateNameRecords(session, Array.from({ length: 513 }, (_, i) => id(i))))
    .rejects.toThrow('wiki_query_budget');
  expect(queries).toBe(1);
});

test('G-845: 200 Unicode code points pass; direct and fallback overflow receive the typed passage problem', () => {
  const valid = bundle();
  valid.claims[0]!.evidence = [evidence('😀'.repeat(200))];
  expect(checkWikiExtraction(valid)).toBe(valid);
  expect(extractionQuotationUses(valid)[0]!.codePoints).toBe(200);
  valid.claims[0]!.evidence = [evidence('😀'.repeat(201))];
  expect(() => checkWikiExtraction(valid)).toThrow('wiki_passage_limit');
  const fallback = { ...evidence(), locator: { ...evidence().locator,
    quote: { type: 'TextQuoteSelector' as const, exact: evidence().quote, prefix: 'a'.repeat(201) } } };
  valid.claims[0]!.evidence = [fallback as never];
  expect(() => checkWikiExtraction(valid)).toThrow('wiki_passage_limit');
});

test('G-845: Main framework validation preserves passage problems and missing OAuth scope fails before graph reads', async () => {
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async () => { throw new Error('Denied/invalid intake must not query'); };
  // Wiki intake is platform:wiki-agents. The OAuth scope check runs after that gate opens.
  const deps = { account: { verify: async (_request: Request, scopes: string[]) => {
    expect(scopes).toEqual(['wiki:propose']);
    throw new AccountAssertionDenied('wiki:propose required');
  } }, environment: { fuseki: graph }, platformAccess: { require: async (_principal: unknown, exposure: string) => {
    if (exposure !== 'platform:wiki-agents') throw new PlatformClosed();
  } } } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  const call = (path: string, body: object) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const long = bundle();
  long.claims[0]!.evidence = [evidence('😀'.repeat(201))];
  const rejected = await call('/v1/wiki/validations', { actingSubject: id(9), bundle: long });
  expect(rejected.status).toBe(422);
  expect(await rejected.json()).toMatchObject({ code: 'wiki_passage_limit' });
  const denied = await call('/v1/wiki/validations', { actingSubject: id(9), bundle: bundle() });
  expect(denied.status).toBe(401);
  const candidateDenied = await call('/v1/wiki/candidates', { actingSubject: id(9), target: id(1), zone: id(2),
    names: [{ value: 'Elizabeth', language: 'en' }] });
  expect(candidateDenied.status).toBe(401);
});

test('G-845: intake position fences reject concurrent graph changes and recovery holds without partial previews', async () => {
  for (const moved of [false, true]) {
    let calls = 0;
    const graph = new FusekiClient('http://graph.invalid');
    graph.query = async query => {
      expect(query).toContain('FILTER NOT EXISTS');
      expect(query).toContain('rv:restoreHold true');
      calls++;
      return { results: { bindings: [{ epoch: { type: 'literal', value: 'epoch' },
        sequence: { type: 'literal', value: moved && calls > 1 ? '2' : '1' } }] } };
    };
    const deps = { environment: { fuseki: graph, objectDirectory: '.temp/g-845-fence',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } } as MainWorkDependencies;
    const operation = wikiRead(deps, { issuer: 'account', subject: 'holder' }, id(9),
      async read => ({ sourcePosition: read.session.position }));
    if (moved) await expect(operation).rejects.toBeInstanceOf(WorkReadMoved);
    else expect(await operation).toEqual({ sourcePosition: { dataEpoch: 'epoch', sequence: '1' } });
    graph.query = async () => ({ results: { bindings: [] } });
    await expect(wikiRead(deps, { issuer: 'account', subject: 'holder' }, id(9), async () => 'preview'))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('G-845: exact quotation plus locator counts once; applied use and distinct locations count correctly', async () => {
  const valid = bundle();
  const first = evidence('a'.repeat(200));
  valid.claims[0]!.evidence = [first, first, { ...first, locator: { ...first.locator,
    selector: { end: 100, start: 0, unit: 'byte', type: 'ByteRangeSelector' } } }];
  const uses = extractionQuotationUses(valid);
  expect(uses).toHaveLength(1);
  expect(evidenceQuotationUses(evidence(first.quote, 100))[0]!.locatorDigest).not.toBe(uses[0]!.locatorDigest);
  const preview = await quotationPreview({ read: async () => ({ appliedCodePoints: 10000,
    existing: new Set([quotationKey(uses[0]!)]) }) }, id(1), uses);
  expect(preview.addedCodePoints).toBe(0);
  await expect(quotationPreview({ read: async () => ({ appliedCodePoints: 9801, existing: new Set() }) }, id(1), uses))
    .rejects.toBeInstanceOf(WikiRejected);
  expect(WIKI_QUOTATION_POLICY.version).toBe(1);
  const mismatch = { ...first, locator: { ...first.locator,
    quote: { type: 'TextQuoteSelector' as const, exact: 'Different source passage' } } };
  expect(() => evidenceQuotationUses(mismatch)).toThrow('wiki_quote_mismatch');
  const padded = { ...first, locator: { ...first.locator,
    quote: { type: 'TextQuoteSelector' as const, exact: first.quote, prefix: 'Context' } } };
  expect(() => evidenceQuotationUses(padded)).toThrow('wiki_passage_limit');
});

test('G-845: names use exact NFKC comparison, including width variants and language-independent scripts', () => {
  expect(wikiLabel(' Ｅｌｉｚａｂｅｔｈ ')).toBe(wikiLabel('Elizabeth'));
  expect(wikiLabel('Elizabeth')).not.toBe(wikiLabel('Elizabeth Bennet'));
  expect(wikiLabel('エリザベス')).not.toBe(wikiLabel('Elizabeth'));
});

test('G-845: candidate/evidence bounds fail explicitly, preserving complete 64 × 16 disclosed results', () => {
  const matches = Array.from({ length: 64 }, (_, name) => new Set(Array.from({ length: 16 }, (_, item) => id(name * 16 + item))));
  const availability = new Map<string, boolean>(matches.flatMap(match => [...match].map(target => [target, true] as const)));
  expect(candidateItems(matches, availability)).toHaveLength(64);
  expect(candidateItems(matches, availability).every(item => item.candidates.length === 16)).toBe(true);
  expect(() => candidateItems([...matches, new Set()], availability)).toThrow('invalid_wiki_candidates');
  matches[0]!.add(id(1024)); availability.set(id(1024), true);
  expect(() => candidateItems(matches, availability)).toThrow('wiki_query_budget');
  availability.set(id(1024), false);
  expect(candidateItems(matches, availability)[0]).toEqual({ index: 0, status: 'ambiguous',
    candidates: [...matches[0]!].filter(target => target !== id(1024)).sort() });
  const request = { target: id(1), zone: id(2), names: Array.from({ length: 64 }, () => ({ value: 'Elizabeth', language: 'en' })) };
  expect(Value.Check(WikiCandidatesSchema, request)).toBe(true);
  request.names.push({ value: 'Jane', language: 'en' });
  expect(Value.Check(WikiCandidatesSchema, request)).toBe(false);
  const valid = bundle();
  valid.claims[0]!.evidence = Array.from({ length: 16 }, () => evidence());
  expect(Value.Check(WikiExtractionSchema, valid)).toBe(true);
  valid.claims[0]!.evidence.push(evidence());
  expect(Value.Check(WikiExtractionSchema, valid)).toBe(false);
  valid.claims[0]!.evidence = [];
  expect(Value.Check(WikiExtractionSchema, valid)).toBe(false);
});
