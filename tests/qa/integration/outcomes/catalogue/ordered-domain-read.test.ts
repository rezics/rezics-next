import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/catalogue/ordered-domain-read.ts';
import { collectionCases, orderCases, type CollectionKey } from '../../../fixtures/catalogue-information-matrix.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName, PersonaSessions } from '../../../support/personas.ts';
import {
  assertCollectionPurpose, body, loadInformationCorpus, noHidden, openInformationCorpus, publicRead, resourcePath,
  type InformationCorpus, type PartsPage,
} from '../../support/catalogue-information.ts';

setDefaultTimeout(120_000);
let corpus: InformationCorpus;
let sessions: PersonaSessions;

async function orderedDomainRead(persona: PersonaName): Promise<void> {
  const read = publicRead(sessions[persona]);
  for (const key of Object.keys(collectionCases) as CollectionKey[]) await assertCollectionPurpose(read, corpus, key);
  for (const key of orderCases) {
    const expected = corpus.orders[key];
    const parts: PartsPage['parts'] = [], cursors = new Set<string>();
    let after: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '1', ...(expected.parent ? { parent: expected.parent } : {}), ...(after ? { after } : {}) });
      const page = await body<PartsPage>(read, `${resourcePath(expected.resource, 'parts')}?${query}`);
      expect(page).toMatchObject({ resource: expected.resource, structure: expected.structure, revision: expected.revision });
      expect(page.parts.length).toBeLessThanOrEqual(1);
      noHidden(page, corpus);
      parts.push(...page.parts);
      after = page.next;
      if (after) {
        expect(cursors.has(after)).toBe(false);
        cursors.add(after);
        expect(cursors.size).toBeLessThan(32);
      }
    } while (after);
    expect(cursors.size, `${key} must exercise a real continuation`).toBeGreaterThan(0);
    expect(parts.map(part => part.occurrence)).toEqual(expected.items.map(part => part.occurrence));
    expect(new Set(parts.map(part => part.occurrence)).size).toBe(parts.length);
    for (const [index, part] of parts.entries()) {
      const source = expected.items[index]!;
      expect(part).toMatchObject({ occurrence: source.occurrence, parent: source.parent,
        role: source.role, target: source.target, sourceOrder: source.sourceOrder });
      expect(part.segmentKey.length).toBeGreaterThan(0);
      expect(part.orderKey.length).toBeGreaterThan(0);
      // Follow the actual target, never reconstruct a route by matching a label.
      if (part.target) {
        const target = await body<{ target: { resource: string; base: string } }>(read, resourcePath(part.target.resource, 'page'));
        expect(target.target).toMatchObject({ resource: part.target.resource, base: part.target.base });
      }
    }
    expect(parts.map(part => part.orderKey)).toEqual(parts.map(part => part.orderKey).toSorted());
    // The same source revision yields the same first occurrence on return.
    const query = new URLSearchParams({ limit: '1', ...(expected.parent ? { parent: expected.parent } : {}) });
    const returned = await body<PartsPage>(read, `${resourcePath(expected.resource, 'parts')}?${query}`);
    expect(returned.parts[0]?.occurrence).toBe(parts[0]?.occurrence);
  }
}

describe(declaration.rowId, () => {
  beforeAll(async () => {
    corpus = loadInformationCorpus();
    sessions = await openInformationCorpus(corpus);
  }, 600_000);
  afterAll(async () => { await sessions?.close(); });
  outcomeTest(declaration, 'visitor', () => orderedDomainRead('visitor'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'stranger', () => orderedDomainRead('stranger'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'member', () => orderedDomainRead('member'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'owner', () => orderedDomainRead('owner'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'moderator', () => orderedDomainRead('moderator'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'operator', () => orderedDomainRead('operator'), undefined, { pending: 'assert' });
});
