import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  canonicalCandidate,
  type OwnerReceipt,
  type CommandOutcome,
} from '../src/modules/editorial-review/contract.ts';
import { checkWikiDelta, type WikiDelta } from '../src/modules/wiki/delta.ts';
import {
  wikiHistory,
  wikiRevisionSet,
  discloseWikiHistory,
  assertWikiBase,
} from '../src/modules/wiki/history.ts';
import type { WikiExtraction } from '../src/modules/wiki/protocol.ts';
const native = () => `https://rezics.com/id/${randomUUID()}`;
const work = native(),
  zone = native(),
  predicate = native(),
  entity = native();
const evidence = {
  quote: 'The family',
  locator: {
    version: 'rezics-locator-v1' as const,
    source: {
      type: 'external' as const,
      representationSha256: 'a'.repeat(64),
      mediaType: 'text/plain',
    },
    selector: { type: 'TextQuoteSelector' as const, exact: 'The family', prefix: 'before' },
  },
};
const bundle: WikiExtraction = {
  profile: 'wiki-extraction-v1',
  target: work,
  zone,
  continuity: work,
  source: {
    representationSha256: 'a'.repeat(64),
    mediaType: 'text/plain',
    language: 'en',
    rightsBasis: 'public_domain',
    method: { agent: 'Holder', model: 'local', inference: 'local' },
  },
  units: [{ id: 'one', ordinal: 0, label: 'Chapter 1', occurrence: native() }],
  entities: [],
  claims: [0, 1].map((index) => ({
    subject: entity,
    predicate,
    object: { kind: 'literal', value: `fact-${index}` },
    modality: 'narrated',
    continuity: work,
    revealedAt: 'one',
    evidence: [evidence],
  })),
};
function receipt(
  candidate: unknown,
  items: Record<string, { component: string; revision: string } | null>,
): OwnerReceipt {
  const proposal = randomUUID(),
    canonical = canonicalCandidate(candidate);
  const commands: CommandOutcome[] = Object.entries(items).map(([key, result]) => ({
    key: `wiki:${proposal}:1:${key}`,
    outcome: result ? 'applied' : 'rejected',
    receipt: result ? native() : null,
    result,
  }));
  return {
    proposal,
    revision: 1,
    receipt: native(),
    operationKey: proposal,
    candidate: canonical.candidate,
    candidateDigest: canonical.digest,
    before: {},
    beforeHeads: [{ component: work, head: native() }],
    afterHeads: [{ component: work, head: native() }],
    owner: {},
    commands,
  };
}
test('G-693: omission never ends accepted claims; only successful reviewed ending commands do', () => {
  const first = receipt(bundle, {
    'claim:0': { component: native(), revision: native() },
    'claim:1': { component: native(), revision: native() },
  });
  const old = wikiHistory(work, [first]);
  const delta: WikiDelta = {
    profile: 'wiki-delta-v1',
    base: old.revisions,
    bundle: { ...bundle, claims: [bundle.claims[0]!] },
    changes: [
      {
        claim: old.claims[0]!.claim,
        revision: old.claims[0]!.revision,
        operation: 'retract',
        reason: 'Chapter 4 correction',
        evidenceClaim: 0,
      },
    ],
  };
  expect(checkWikiDelta(delta)).toEqual(delta);
  const rejected = receipt(delta, { 'delta-end:0': null });
  expect(wikiHistory(work, [first, rejected]).claims).toEqual(old.claims);
  const applied = receipt(delta, {
    'delta-end:0': { component: old.claims[0]!.claim, revision: native() },
  });
  expect(wikiHistory(work, [first, applied]).claims).toEqual([old.claims[1]!]);
  expect(wikiHistory(work, [first])).toEqual(old);
  expect(() => assertWikiBase(old.revisions, [first, applied])).toThrow('stale_base');
});
test('G-693: missing citation, duplicate target, blank reason and malformed accepted base are rejected', () => {
  const first = receipt(bundle, { 'claim:0': { component: native(), revision: native() } });
  const old = wikiHistory(work, [first]);
  const delta = {
    profile: 'wiki-delta-v1',
    base: wikiRevisionSet([first]),
    bundle,
    changes: [
      {
        claim: old.claims[0]!.claim,
        revision: old.claims[0]!.revision,
        operation: 'amend',
        reason: 'Correction',
        evidenceClaim: 0,
      },
    ],
  };
  for (const invalid of [
    { ...delta, changes: [{ ...delta.changes[0], evidenceClaim: 255 }] },
    { ...delta, changes: [delta.changes[0], delta.changes[0]] },
    { ...delta, changes: [{ ...delta.changes[0], reason: '  ' }] },
    { ...delta, base: [delta.base[0], delta.base[0]] },
  ]) {
    expect(() => checkWikiDelta(invalid)).toThrow();
  }
});
test('G-693: retained history redacts every quote fallback on each read without changing immutable pins', async () => {
  const first = receipt(bundle, { 'claim:0': { component: native(), revision: native() } });
  const pin = wikiHistory(work, [first]);
  const blocked = await discloseWikiHistory(
    pin,
    { withheld: async (ids) => new Set(ids) },
    undefined,
  );
  expect(JSON.stringify(blocked)).not.toContain('The family');
  expect(JSON.stringify(blocked)).not.toContain('before');
  expect(blocked.claims[0]!.value.evidence[0]).toMatchObject({ quote: null, quoteWithheld: true });
  expect(blocked.revisions).toEqual(pin.revisions);
  expect(pin.claims[0]!.value.evidence[0]!.quote).toBe('The family');
});
test('G-693: repeated local unit IDs never retarget earlier accepted citations', () => {
  const first = receipt(bundle, { 'claim:0': { component: native(), revision: native() } });
  const laterUnit = { ...bundle.units[0]!, occurrence: native(), label: 'Chapter 4' };
  const later = receipt(
    { ...bundle, units: [laterUnit] },
    { 'claim:0': { component: native(), revision: native() } },
  );
  const history = wikiHistory(work, [first, later]);
  expect(history.claims.map((claim) => claim.value.revealedAt)).toEqual([
    bundle.units[0]!.occurrence!,
    laterUnit.occurrence,
  ]);
  expect(history.units.map((unit) => unit.id)).toEqual([
    bundle.units[0]!.occurrence!,
    laterUnit.occurrence,
  ]);
});
