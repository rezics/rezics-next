import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { renderProfile } from '../compiler/ir.ts';
import { classificationPropositionProfile } from '../definitions/classification-proposition-v1.ts';
import { semanticAnnotationProfile } from '../definitions/semantic-annotation-v1.ts';

test('MODEL13: generated profiles retain OA Annotation, SKOS-XL Label and SKOS preferred label terms', () => {
  for (const profile of [semanticAnnotationProfile, classificationPropositionProfile]) {
    const generated = readFileSync(new URL(`../../generated/model/shapes/${profile.id}.ttl`,
      import.meta.url), 'utf8');
    const registered = profileRegistry[profile.id];
    expect(generated).toBe(renderProfile(profile));
    expect(createHash('sha256').update(generated).digest('hex')).toBe(registered.sha256);
  }
  const annotation = semanticAnnotationProfile.shapes[1]!;
  expect(annotation.properties).toContainEqual({ path: 'rdf:type', hasValue: 'oa:Annotation' });
  expect(annotation.properties).toContainEqual({ path: 'oa:hasTarget', minCount: 1,
    maxCount: 16, nodeKind: 'sh:IRI' });
  expect(annotation.properties.find(property => property.path === 'oa:motivatedBy'))
    .toMatchObject({ minCount: 1, maxCount: 1,
      in: expect.arrayContaining(['oa:commenting']) });
  const target = semanticAnnotationProfile.shapes[2]!;
  expect(target.properties).toContainEqual({ path: 'rdf:type', hasValue: 'oa:SpecificResource' });
  expect(target.properties).toContainEqual({ path: 'oa:hasSource', minCount: 1,
    maxCount: 1, nodeKind: 'sh:IRI' });
  expect(target.properties).toContainEqual({ path: 'oa:hasSelector', minCount: 1,
    maxCount: 1, class: 'oa:TextQuoteSelector' });
  const selector = semanticAnnotationProfile.shapes[3]!;
  expect(selector.properties).toContainEqual({ path: 'rdf:type', hasValue: 'oa:TextQuoteSelector' });
  for (const term of ['oa:exact', 'oa:prefix', 'oa:suffix']) {
    expect(selector.properties.find(property => property.path === term))
      .toMatchObject({ minCount: 1, maxCount: 1, datatype: 'xsd:string' });
  }
  const label = semanticAnnotationProfile.shapes[0]!;
  expect(label.properties).toContainEqual({ path: 'rdf:type', hasValue: 'skosxl:Label' });
  expect(label.properties).toContainEqual({ path: 'skosxl:literalForm', minCount: 1,
    maxCount: 1, datatype: 'rdf:langString', maxLength: 1000 });
  expect(label.properties).toContainEqual({ path: 'rv:nameRole', maxCount: 1,
    nodeKind: 'sh:IRI' });
  const concept = classificationPropositionProfile.shapes.find(shape =>
    shape.iri.endsWith('/concept-shape'))!;
  expect(concept.properties.find(property => property.path === 'skos:prefLabel'))
    .toMatchObject({ datatype: 'rdf:langString', uniqueLang: true });
});
