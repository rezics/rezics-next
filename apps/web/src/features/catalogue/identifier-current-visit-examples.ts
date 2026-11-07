import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json';
import type { SubjectPageData } from '../pages/page-model';
import { identifiersProfileFixture, identifiersStatement } from '../../kernel/fake/catalogue-identifiers-profile';
import { candidateContext } from '../pages/visit-host-port';
import { identifierEvidenceFromPage } from './identifier-current-visit-evidence';

export const identifierExampleRealm = 'b7d92525-081e-42e1-9cb8-ef72b1492a25';
export const identifierExampleContext = '0ac7c5d7-1f67-4d02-8a72-0676044ecb19';
export const identifierExampleDuplicate = '00000000-0000-4000-8000-00000000d119';
export const identifierExampleAddress = { property: 'schema:isbn', statement: identifiersStatement };

/** Synthetic native-shaped public page, shared only by the named tests and stories. */
export function identifierVisitExample(realm = true) {
  const fixture = identifiersProfileFixture();
  const read = structuredClone(fixture.publicRead);
  read.subject.context = realm ? identifierExampleContext : candidateContext;
  const original = read.subject.statements['schema:isbn']![0]!;
  read.subject.statements['schema:isbn']!.push({
    ...structuredClone(original),
    id: identifierExampleDuplicate,
    references: [
      {
        hash: 'second-group',
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: 'https://catalogue.example/second' },
          },
        ],
      },
    ],
  });
  const origin = realm
    ? { kind: 'realm' as const, context: identifierExampleContext, realm: identifierExampleRealm }
    : undefined;
  const context = {
    id: read.subject.context,
    population: realm
      ? { kind: 'realm' as const, id: identifierExampleRealm, title: 'Example Realm' }
      : { kind: 'global' as const },
  };
  const document = platform.generic.views.overview as unknown as CompositionDocument;
  const page: SubjectPageData = {
    subject: read.subject.id,
    profile: 'example',
    template: { scope: 'base', key: null },
    document: document as SubjectPageData['document'],
    context,
    requestedRealm: origin?.realm,
    catalogue: {
      state: 'released',
      type: read.subject.type,
      definitions: fixture.release,
      digest: read.subject.release,
    },
    reads: Object.fromEntries(
      Object.entries(planReads(platformRegistry, document, { subject: read.subject.id, context }).reads).map(
        ([key, planned]) => [key, { status: 200, body: planned.kind === 'subject' ? read : {} }],
      ),
    ),
  };
  const result = identifierEvidenceFromPage(page, read.subject.id, origin);
  if (result.kind !== 'ready') throw new Error('Identifier example needs a public reading');
  return { fixture, read, page, origin, result, evidence: result.evidence };
}
