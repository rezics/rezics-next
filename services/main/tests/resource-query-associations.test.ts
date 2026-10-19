import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { ASSOCIATION_QUERY, associationRequest, associationResult, type AssociationSelection,
  type AssociationWitness } from '../src/modules/query/association-contract.ts';
import { selectAssociations } from '../src/modules/query/association-selection.ts';
import { AssociationCursorInvalid, AssociationStaleQuery, associationMatchSelection, associationOrderKey,
  issueAssociationCursor, readAssociationCursor, type AssociationFrontier, type AssociationReadBasis,
  type AssociationKey } from '../src/modules/query/association-cursor.ts';
import { readAssociationPage, type AssociationPageSource } from '../src/modules/query/association-page.ts';
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
const key = (n: number, atWork = work): AssociationKey => ({ work: atWork, occurrence: id(1000 + n), subjectParticipation: id(2000 + n) });
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
        : associationOrderKey(k) > associationOrderKey(after.key)));
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
    for (const all of [[{ ...predicate, value: { kind: 'rational', lexical: '2/4' } }],
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
  test('outer Work continuations skip emitted groups and current fences run before return', async () => {
    const keys = [key(1), key(2), key(3, id(9)), key(4, id(10))];
    const map = new Map(keys.map((k, n) => [associationOrderKey(k), witness(n + 1, k.work)]));
    const { owner } = source(keys, k => ({ ...map.get(associationOrderKey(k))!, ...k }));
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
    owner.candidates = async () => { throw new WorkReadUnavailable('association coverage is not active'); };
    await expect(readAssociationPage(owner, selection, basis(), 'query')).rejects.toBeInstanceOf(WorkReadUnavailable);
  });
});
