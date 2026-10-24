import { afterAll, beforeAll, describe, expect, setDefaultTimeout } from 'bun:test';
import declaration from '../../../../../scripts/qa/cases/outcomes/catalogue/supporting-information.ts';
import { supportingRecords, type SupportingKey } from '../../../fixtures/catalogue-information-matrix.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName, PersonaSessions } from '../../../support/personas.ts';
import {
  assertEdge, assertField, assertIdentity, assertReadableNativeFacts, body, factGroups, loadInformationCorpus,
  noHidden, openInformationCorpus, publicRead, relations, resourcePath,
  type EntityPage, type InformationCorpus,
} from '../../support/catalogue-information.ts';

setDefaultTimeout(120_000);
let corpus: InformationCorpus;
let sessions: PersonaSessions;

async function supportingInformation(persona: PersonaName): Promise<void> {
  const read = publicRead(sessions[persona]);
  const admitted = await body<{ types: { type: string; base: string; labels: { en: { one: string } } }[] }>(read, '/v1/types');
  for (const key of Object.keys(supportingRecords) as SupportingKey[]) {
    const expected = corpus.records[key], specification = supportingRecords[key];
    const page = await body<EntityPage>(read, resourcePath(expected.resource, 'page'));
    assertIdentity(page, key, corpus);
    expect(page.summary).toMatchObject({ status: 'available', name: { value: expected.name } });
    expect(admitted.types.find(type => type.type === page.registry.type)).toMatchObject({
      type: specification.type, labels: page.registry.labels,
    });
    // A descriptive type selects presentation; it cannot confer structural ownership.
    if (['person', 'organization', 'artist', 'label'].includes(key)) {
      expect(page.target.types).not.toContain('https://rezics.com/vocab/Agent');
      expect(page.target.types).not.toContain('https://rezics.com/vocab/OrganizationAgent');
    }
    if (key === 'publicationEvent') {
      expect(page.target.base).toBe('resource');
      expect(page.target.types).not.toContain('https://rezics.com/vocab/Release');
    }
    const groups = await factGroups(read, expected.resource, corpus);
    for (const field of expected.fields) assertField(groups, field);
    expect(groups.map(group => group.display.order)).toEqual(groups.map(group => group.display.order).toSorted((a, b) => a - b));
  }
  for (const [key, expected] of Object.entries(corpus.inverse)) {
    const resource = corpus.records[key as SupportingKey].resource;
    const items = await relations(read, resource, corpus);
    for (const edge of expected) {
      assertEdge(items, edge);
      const inverse = await relations(read, edge.counterpart, corpus);
      assertEdge(inverse, { ...edge, counterpart: resource,
        counterpartBase: supportingRecords[key as SupportingKey].base,
        viewingRole: edge.counterpartRole, counterpartRole: edge.viewingRole });
    }
  }
  const native = corpus.records.nativeRelease;
  const releaseChoices = await body<{ items: { id: string }[] }>(read,
    `/v1/works/${native.work!.slice(-36)}/releases?limit=20`);
  expect(releaseChoices.items.map(item => item.id)).toContain(native.resource);
  expect(releaseChoices.items.map(item => item.id)).not.toContain(corpus.records.publicationEvent.resource);
  noHidden(releaseChoices, corpus);

  // Exercise Access, not merely the absence of an Agent type in a display object.
  for (const key of ['person', 'organization'] as const) {
    const response = await sessions[persona].main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Descriptive identity grants no acting authority', language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: corpus.records[key].resource,
    });
    expect(response.status, await response.clone().text()).toBe(persona === 'visitor' ? 401 : 403);
    noHidden(await response.json(), corpus);
  }
  await assertReadableNativeFacts(read, corpus);
}

describe(declaration.rowId, () => {
  // Setup failures are separate from product assertions. Pending is declaration
  // state; baseline assertions report their genuine result without inversion.
  beforeAll(async () => {
    corpus = loadInformationCorpus();
    sessions = await openInformationCorpus(corpus);
  }, 600_000);
  afterAll(async () => { await sessions?.close(); });
  outcomeTest(declaration, 'visitor', () => supportingInformation('visitor'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'stranger', () => supportingInformation('stranger'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'member', () => supportingInformation('member'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'owner', () => supportingInformation('owner'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'moderator', () => supportingInformation('moderator'), undefined, { pending: 'assert' });
  outcomeTest(declaration, 'operator', () => supportingInformation('operator'), undefined, { pending: 'assert' });
});
