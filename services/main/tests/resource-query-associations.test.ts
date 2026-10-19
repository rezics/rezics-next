import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { ASSOCIATION_QUERY, associationRequest, associationResult, type AssociationSelection,
  type AssociationStatement, type AssociationWitness } from '../src/modules/query/association-contract.ts';
import { selectAssociations } from '../src/modules/query/association-selection.ts';
import { AssociationCursorInvalid, AssociationStaleQuery, associationMatchSelection, associationOrderKey,
  issueAssociationCursor, readAssociationCursor, type AssociationFrontier, type AssociationReadBasis,
  type AssociationKey } from '../src/modules/query/association-cursor.ts';
import { readAssociationPage, type AssociationPageSource } from '../src/modules/query/association-page.ts';
import { matchesAssociation } from '../src/modules/query/association-match.ts';
import { WorkReadInvalid, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { templates } from '../../../generated/query/templates.ts';

const id = (value: number) => `https://rezics.com/id/${value.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const work = id(1), subject = { kind: 'resource' as const, ref: id(2) };
const role = `${id(3)}/role/protagonist`;
const request = () => ({ profile: 'template-query-v1' as const, query: ASSOCIATION_QUERY as typeof ASSOCIATION_QUERY, revision: 1 as const,
  parameters: { kind: 'appearance' as const, direction: 'work-to-subject' as const,
    roots: [{ kind: 'resource' as const, ref: work }], projection: 'occurrence' as const,
    context: 'global' as const, frame: [], position: 'start', match: { all: [], any: [], none: [] } },
  presentation: { language: 'en' }, limit: 20 });
const basis = (): AssociationReadBasis => ({ snapshot: { sourcePosition: {
  datasetId: 'product', dataEpoch: 'epoch-a', sequence: '23' }, modelGeneration: 'model-a' },
  reader: { account: 'public', actor: null, languages: ['en'] }, dependencies: { disclosure: 'current', activation: 'covered' } });
const key = (n: number, atWork = work): AssociationKey & { subjectParticipation: string } => ({ work: atWork, occurrence: id(1000 + n), subjectParticipation: id(2000 + n) });
function witness(n: number, atWork = work): AssociationWitness {
  const k = key(n, atWork);
  return { ...k, kind: 'appearance', revision: id(3000 + n), definition: id(3),
    workParticipation: id(4000 + n), subject, role, context: 'global', applicability: [], qualification: 'asserted',
    participations: [{ id: id(4000 + n), role: `${id(3)}/role/work`, participant: { kind: 'resource', ref: atWork } },
      { id: k.subjectParticipation, role, participant: subject }], statements: [], citations: [{
      id: id(5000 + n), sourceWork: atWork, representationSha256: 'a'.repeat(64), locator: { start: 1 },
      quote: null, quoteWithheld: true, method: { kind: 'manual' }, modality: 'text', submitter: id(6), rightsBasis: 'retained-rights' }],
    sourceVersionStatus: 'exact', labels: { subject: 'subject', role: 'protagonist', work: 'work' }, snippets: [],
    links: [{ rel: 'self', method: 'POST', href: '/v1/query', body: request() }] };
}
function source(rows: AssociationKey[], visible: (key: AssociationKey) => AssociationWitness | null) {
  const calls = { candidates: 0, witnesses: 0, fences: 0 };
  const owner: AssociationPageSource = {
    candidates: async (after, limit) => {
      calls.candidates++;
      const remaining = rows.filter(k => !after || (after.kind === 'work' ? k.work > after.work
        : (after.kind !== 'matches' || k.work === after.key.work) && associationOrderKey(k) > associationOrderKey(after.key)));
      return { items: remaining.slice(0, limit), more: remaining.length > limit };
    }, witness: async k => { calls.witnesses++; return visible(k); }, fence: async () => { calls.fences++; },
  };
  return { owner, calls };
}

describe('Subject association selection', () => {
  test('closed exact inputs preserve external namespaces and require deliberate catalogue omission', () => {
    const original = request();
    expect(selectAssociations(original)).toEqual(original);
    expect(selectAssociations({ ...original, limit: undefined }).limit).toBe(20);
    const { roots: _roots, ...catalogue } = original.parameters;
    expect(() => selectAssociations({ ...original, parameters: catalogue })).toThrow(WorkReadInvalid);
    expect(selectAssociations({ ...original, parameters: { ...catalogue, match: { ...catalogue.match, role } } })
      .parameters.roots).toBeUndefined();
    for (const roots of [null, [], Array.from({ length: 65 }, (_, n) => ({ kind: 'resource', ref: id(n + 1) }))]) {
      expect(() => selectAssociations({ ...original, parameters: { ...original.parameters, roots } })).toThrow(WorkReadInvalid);
    }
    const external = { kind: 'external' as const, provider: 'retained', namespace: 'person', key: 'same' };
    expect(() => selectAssociations({ ...original, parameters: { ...original.parameters, roots: [external] } })).toThrow(WorkReadInvalid);
    const inverse = { ...original, parameters: { ...original.parameters, kind: 'credit', direction: 'subject-to-work',
      roots: [external, { ...external, namespace: 'organization' }] } };
    expect(selectAssociations(inverse).parameters.roots).toEqual(inverse.parameters.roots);
    expect(() => selectAssociations({ ...inverse, parameters: { ...inverse.parameters, roots: [external, { ...external }] } })).toThrow();
    expect(() => selectAssociations({ ...inverse, parameters: { ...inverse.parameters,
      roots: [{ ...external, key: 'invalid\ud800' }] } })).toThrow(WorkReadInvalid);
    for (const template of templates) {
      const parameters = { roots: [external] };
      expect(Value.Check(template.request, { profile: 'template-query-v1', query: template.query,
        revision: 1, parameters })).toBe(false);
    }
  });
  test('the Value owner validates canonical exact values; malformed or duplicate predicates never disappear', () => {
    const input = request();
    const predicate = { predicate: id(8), value: { kind: 'rational' as const, lexical: '1/2' } };
    const selection = (all: unknown[]) => ({ ...input, parameters: { ...input.parameters,
      match: { all, any: [], none: [] } } });
    expect(selectAssociations(selection([predicate])).parameters.match.all).toEqual([predicate]);
    const temporal = { predicate: id(8), value: { kind: 'temporal' as const, lexical: '2026-10-19', precision: 'day' as const,
      calendar: 'gregorian' as const, timeZone: 'America/New_York' } };
    expect(selectAssociations(selection([temporal])).parameters.match.all).toEqual([temporal]);
    for (const all of [[{ ...predicate, value: { kind: 'rational', lexical: '2/4' } }],
      [{ ...predicate, value: { kind: 'language-string', lexical: 'red', language: 'en_US' } }],
      [predicate, { value: predicate.value, predicate: predicate.predicate }], Array(17).fill(predicate)]) {
      expect(() => selectAssociations(selection(all))).toThrow(WorkReadInvalid);
    }
    for (const malformed of [{ ...input, unexpected: true }, { ...input, cursor: 'x'.repeat(2049) },
      { ...input, parameters: { ...input.parameters, match: { all: [], any: [], none: null } } },
      { ...input, parameters: { ...input.parameters, frame: [id(9), id(9)] } }]) {
      expect(Value.Check(associationRequest, malformed)).toBe(false);
    }
  });
});

describe('Subject association predicate correlation', () => {
  const red = { predicate: id(70), value: { kind: 'language-string' as const, lexical: 'red', language: 'en' } };
  const black = { ...red, value: { ...red.value, lexical: 'black' } };
  function statement(overrides: Partial<AssociationStatement> = {}): AssociationStatement {
    return { id: id(71), revision: id(72), subject, ...red, occurrence: key(1).occurrence,
      context: 'global', applicability: [], qualification: 'asserted', decisionRevision: id(73),
      citations: witness(1).citations, ...overrides };
  }
  const selection = (match: AssociationSelection['parameters']['match']) => selectAssociations({
    ...request(), parameters: { ...request().parameters, match } });
  const positive = selection({ role, all: [red], any: [], none: [] });
  test('all, any and none compare exact adopted values on the same subject and occurrence', () => {
    const current = { ...witness(1), statements: [statement()] };
    expect(matchesAssociation(positive, current)).toBe(true);
    expect(matchesAssociation(selection({ all: [red, black], any: [], none: [] }), current)).toBe(false);
    expect(matchesAssociation(selection({ all: [], any: [black, red], none: [] }), current)).toBe(true);
    expect(matchesAssociation(selection({ all: [], any: [], none: [red] }), current)).toBe(false);
    expect(matchesAssociation(selection({ all: [], any: [], none: [black] }), current)).toBe(true);
    for (const other of [statement({ subject: { kind: 'resource', ref: id(90) } }),
      statement({ occurrence: key(2).occurrence }), statement({ predicate: id(74) }),
      statement({ value: { ...red.value, language: 'fr' } }), statement({ value: { ...red.value, direction: 'rtl' } })]) {
      expect(matchesAssociation(positive, { ...current, statements: [other] })).toBe(false);
    }
    expect(matchesAssociation(positive, { ...current, statements: [statement({ occurrence: null })] })).toBe(true);
    // A role is never a predicate mapping, including protagonist to gender.
    expect(matchesAssociation(positive, { ...current, statements: [] })).toBe(false);
    expect(matchesAssociation({ ...positive, parameters: { ...positive.parameters,
      match: { ...positive.parameters.match, role: `${id(3)}/role/male` } } }, current)).toBe(false);
  });
  test('unknown, uncertain and conflicting assertions remain inspectable without satisfying positives', () => {
    for (const qualification of ['uncertain', 'conflicting'] as const) {
      const current = { ...witness(1), statements: [statement({ qualification })] };
      expect(matchesAssociation(positive, current)).toBe(false);
      expect(matchesAssociation(selectAssociations(request()), current)).toBe(true);
      expect(matchesAssociation(selection({ all: [], any: [], none: [red] }), current)).toBe(true);
      expect(matchesAssociation(positive, { ...current, qualification, statements: [statement()] })).toBe(false);
    }
    const unknown = { predicate: red.predicate, value: { kind: 'unknown' as const } };
    expect(matchesAssociation(selection({ all: [unknown], any: [], none: [] }), {
      ...witness(1), statements: [statement({ value: unknown.value })] })).toBe(false);
  });
  test('matching precedes Work grouping and counts and never joins two witnesses', async () => {
    const rows = [key(1), key(2)];
    const { owner } = source(rows, k => k.occurrence === rows[0]!.occurrence
      ? { ...witness(1), statements: [] }
      : { ...witness(2), role: `${id(3)}/role/supporting`, statements: [statement({ occurrence: key(2).occurrence })] });
    const result = await readAssociationPage(owner, { ...positive, parameters: {
      ...positive.parameters, projection: 'work' } }, basis(), 'query');
    expect(result.items).toEqual([]); expect(result.count.value).toBe(0); expect(result.complete).toBe(true);
  });
});

describe('Subject association continuation', () => {
  test('every admitted large selection produces a bounded round-tripping opaque cursor', () => {
    const input = request();
    const all = Array.from({ length: 16 }, (_, n) => ({ predicate: id(n + 10),
      value: { kind: 'string', lexical: 'value'.repeat(1600) } }));
    const selection = selectAssociations({ ...input, parameters: { ...input.parameters, roots:
      Array.from({ length: 64 }, (_, n) => ({ kind: 'resource', ref: id(n + 1) })), match: { all, any: [], none: [] } } });
    const frontier: AssociationFrontier = { kind: 'occurrence', key: key(1) };
    const token = issueAssociationCursor(selection, basis(), 'query', frontier, Date.now() + 60_000);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(token).not.toContain(work);
    expect(readAssociationCursor(token, selection, basis(), 'query').frontier).toEqual(frontier);
  });
  test('reader, effective actor, surface and all selection changes refuse a cursor', () => {
    const input = selectAssociations(request()), at = basis();
    const token = issueAssociationCursor(input, at, 'query', { kind: 'occurrence', key: key(1) }, Date.now() + 60_000);
    const changes: AssociationSelection[] = [
      { ...input, limit: 2 }, { ...input, presentation: { language: 'zh-Hans' } },
      { ...input, presentation: { ...input.presentation, actingSubject: id(10) } },
      { ...input, parameters: { ...input.parameters, position: 'all' } },
      { ...input, parameters: { ...input.parameters, projection: 'work' } },
      { ...input, parameters: { ...input.parameters, context: { realm: id(10) } } },
      { ...input, parameters: { ...input.parameters, frame: [id(10)] } },
      { ...input, parameters: { ...input.parameters, roots: [{ kind: 'resource', ref: id(10) }] } },
      { ...input, parameters: { ...input.parameters, match: { ...input.parameters.match, role } } },
    ];
    for (const changed of changes) expect(() => readAssociationCursor(token, changed, at, 'query')).toThrow(AssociationCursorInvalid);
    expect(() => readAssociationCursor(token, input, { ...at, reader: { account: 'other' } }, 'query')).toThrow(AssociationCursorInvalid);
    expect(() => readAssociationCursor(token, input, at, 'work-credits')).toThrow(AssociationCursorInvalid);
  });
  test('source, model, restore, disclosure and expired bases require an explicit selection-preserving restart', () => {
    const selection = selectAssociations(request()), at = basis();
    const token = issueAssociationCursor(selection, at, 'query', { kind: 'occurrence', key: key(1) }, Date.now() + 60_000);
    const changed: AssociationReadBasis[] = [
      { ...at, snapshot: { ...at.snapshot, sourcePosition: { ...at.snapshot.sourcePosition, sequence: '24' } } },
      { ...at, snapshot: { ...at.snapshot, modelGeneration: 'model-b' } },
      { ...at, snapshot: { ...at.snapshot, sourcePosition: { ...at.snapshot.sourcePosition, dataEpoch: 'restored' } } },
      { ...at, dependencies: { disclosure: 'revoked' } },
    ];
    for (const current of changed) expect(() => readAssociationCursor(token, selection, current, 'query')).toThrow(AssociationStaleQuery);
    const pinned = { ...selection, parameters: { ...selection.parameters, snapshot: changed[0]!.snapshot } };
    try { readAssociationCursor(undefined, pinned, at, 'query'); throw new Error('expected stale'); }
    catch (error) {
      expect(error).toBeInstanceOf(AssociationStaleQuery);
      expect((error as AssociationStaleQuery).restart).toEqual({ method: 'POST', path: '/v1/query', body: selection });
    }
    const expired = issueAssociationCursor(selection, at, 'query', { kind: 'occurrence', key: key(1) }, Date.now() - 1);
    expect(() => readAssociationCursor(expired, selection, at, 'query')).toThrow(AssociationStaleQuery);
  });
  test('sparse hidden frontiers continue past 800 and finish without duplicates or loss', async () => {
    const keys = Array.from({ length: 866 }, (_, n) => key(n));
    const byKey = new Map(keys.slice(801).map((k, n) => [associationOrderKey(k), witness(n + 801)]));
    const { owner, calls } = source(keys, k => byKey.get(associationOrderKey(k)) ?? null);
    const selection = selectAssociations({ ...request(), limit: 2 }), found: AssociationWitness[] = [];
    const cursors = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await readAssociationPage(owner, selection, basis(), 'query', token);
      expect(Value.Check(associationResult, result)).toBe(true);
      if (page === 0) { expect(result.items).toEqual([]); expect(result.complete).toBe(false); }
      found.push(...result.items as AssociationWitness[]);
      expect(result.count.value).toBe(result.items.length);
      if (!result.nextCursor) break;
      expect(cursors.has(result.nextCursor)).toBe(false);
      cursors.add(result.nextCursor); token = result.nextCursor;
    }
    expect(found.map(associationOrderKey)).toEqual([...byKey.keys()]);
    expect(new Set(found.map(associationOrderKey)).size).toBe(65);
    expect(calls.witnesses).toBe(866); expect(calls.fences).toBe(calls.candidates);
  });
  test('distinct Work pages retain a 65th witness through a separate occurrence continuation', async () => {
    const keys = Array.from({ length: 65 }, (_, n) => key(n));
    const map = new Map(keys.map((k, n) => [associationOrderKey(k), witness(n)]));
    const { owner } = source(keys, k => map.get(associationOrderKey(k))!);
    const selection = selectAssociations({ ...request(), limit: 1,
      parameters: { ...request().parameters, projection: 'work' } });
    const page = await readAssociationPage(owner, selection, basis(), 'query');
    expect(Value.Check(associationResult, page)).toBe(true);
    expect(page.complete).toBe(true); expect(page.count.value).toBe(1);
    const match = (page.items[0] as { matches: { items: AssociationWitness[]; nextCursor: string; complete: boolean } }).matches;
    expect(match.items.length).toBe(64); expect(match.complete).toBe(false);
    await expect(readAssociationPage(owner, selection, basis(), 'query', match.nextCursor)).rejects.toBeInstanceOf(AssociationCursorInvalid);
    const rest = await readAssociationPage(owner, associationMatchSelection(selection, work), basis(), 'query', match.nextCursor);
    expect(rest.complete).toBe(true);
    expect([...match.items, ...rest.items as AssociationWitness[]].map(associationOrderKey)).toEqual(keys.map(associationOrderKey));
  });
  test('inverse nested continuations retain full external roots and stay within one Work', async () => {
    const external = { kind: 'external' as const, provider: 'retained', namespace: 'person', key: 'same' };
    const keys = [...Array.from({ length: 65 }, (_, n) => key(n)), key(66, id(9))];
    const map = new Map(keys.map((k, n) => [associationOrderKey(k), { ...witness(n, k.work), ...k,
      kind: 'credit' as const, subject: external }]));
    const { owner } = source(keys, k => map.get(associationOrderKey(k))!);
    const selection = selectAssociations({ ...request(), limit: 1, parameters: { ...request().parameters,
      kind: 'credit', direction: 'subject-to-work', projection: 'work', roots: [external,
        ...Array.from({ length: 63 }, (_, n) => ({ ...external, key: `${n}${'x'.repeat(500)}` }))] } });
    const first = await readAssociationPage(owner, selection, basis(), 'query');
    expect(first.items.map(item => item.work)).toEqual([work]);
    const match = (first.items[0] as { matches: { items: AssociationWitness[]; nextCursor: string } }).matches;
    const nestedSelection = associationMatchSelection(selection, work);
    expect(nestedSelection.parameters.roots).toEqual(selection.parameters.roots);
    expect(match.nextCursor.length).toBeLessThanOrEqual(2048);
    const rest = await readAssociationPage(owner, nestedSelection, basis(), 'query', match.nextCursor);
    expect(rest.items.map(item => item.work)).toEqual([work]); expect(rest.complete).toBe(true);
    expect([...match.items, ...rest.items as AssociationWitness[]].map(associationOrderKey)).toEqual(keys.slice(0, 65).map(associationOrderKey));
    const second = await readAssociationPage(owner, selection, basis(), 'query', first.nextCursor!);
    expect(second.items.map(item => item.work)).toEqual([id(9)]);
    // Provider and key equality cannot absorb another external namespace.
    const otherNamespace = { ...map.get(associationOrderKey(keys[0]!))!, subject: { ...external, namespace: 'organization' } };
    expect(matchesAssociation(selection, otherNamespace)).toBe(false);
    owner.candidates = async () => ({ items: [keys.at(-1)!], more: false });
    await expect(readAssociationPage(owner, nestedSelection, basis(), 'query', match.nextCursor)).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
  test('outer Work continuations skip emitted groups and current fences run before return', async () => {
    const keys = [key(1), key(2), key(3, id(9)), key(4, id(10))];
    const map = new Map(keys.map((k, n) => [associationOrderKey(k), witness(n + 1, k.work)]));
    const { owner } = source(keys, k => k.subjectParticipation === null ? null
      : ({ ...map.get(associationOrderKey(k))!, ...k, subjectParticipation: k.subjectParticipation }));
    const selection = selectAssociations({ ...request(), limit: 1, parameters: { ...request().parameters,
      roots: [work, id(9), id(10)].map(ref => ({ kind: 'resource', ref })), projection: 'work' } });
    const first = await readAssociationPage(owner, selection, basis(), 'query');
    expect(first.items.map(item => item.work)).toEqual([work]);
    const second = await readAssociationPage(owner, selection, basis(), 'query', first.nextCursor!);
    expect(second.items.map(item => item.work)).toEqual([id(9)]);
    owner.fence = async () => { throw new WorkReadUnavailable('current authority unavailable'); };
    await expect(readAssociationPage(owner, selection, basis(), 'query', second.nextCursor!)).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
  test('incomplete activation, missing progress, repeated keys and mismatched witnesses cannot become complete empty pages', async () => {
    const selection = selectAssociations(request());
    const { owner } = source([key(1)], () => witness(2));
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
    owner.candidates = async () => ({ items: [], more: true });
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
    owner.candidates = async () => ({ items: [key(1), key(1)], more: false });
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
    owner.candidates = async () => ({ items: [{ ...key(1), occurrence: 'invalid' }], more: true });
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
    owner.candidates = async () => { throw new WorkReadUnavailable('association coverage is not active'); };
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
});
