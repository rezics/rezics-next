import { expect, test } from 'bun:test';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { authoredDocumentBody } from '../src/document-body.ts';
import { checkedProcedure, checkedResourceReference, contentDocumentNodes, procedureProjection,
  PROCEDURE_DEFINITION, RESOURCE_REFERENCE_DEFINITION, type ProcedurePayload, type ResourceReference } from '../src/adoption.ts';
import { resolveResourceReference, type ReferenceOwners } from '../src/reference.ts';
import { checkedDerivation, derivationProjection, type ContentDerivationInput } from '../src/derivation.ts';
import { documentImageUses } from '../src/document-media.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const revision = '00000000-0000-4000-8000-000000000003';
const ref: ResourceReference = { target: id(1), selector: { grain: 'content', variantId: 'urn:rezics:variant:00000000-0000-4000-8000-000000000002', revision } };
const extension = (definition: string, payload: unknown, inline = false): DocumentSnapshot => ({
  version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [{
    type: inline ? 'paragraph' : 'extensionBlock', attrs: inline ? { id: 'p' } : { id: 'extension', definition,
      version: '1', fallback: 'Instruction fallback', payload: payload as never },
    ...(inline ? { content: [{ type: 'extensionInline', attrs: { id: 'ref', definition, version: '1', fallback: 'Reference fallback', payload: payload as never } }] } : {}),
  }] },
});
const procedure = (): ProcedurePayload => ({ items: [
  { id: 'before', type: 'HowToStep', document: fromPlainText('Before', 'blocks') },
  { id: 'section', type: 'HowToSection', name: { value: 'Sauce', language: 'en' }, items: [
    { id: 'step', type: 'HowToStep', document: extension(RESOURCE_REFERENCE_DEFINITION, ref, true) },
  ] }, { id: 'empty', type: 'HowToSection', name: { value: 'Garnish', language: 'en' }, items: [] },
] });

test('Content admits one ordered procedure with empty sections, step documents and references', () => {
  const payload = procedure(); const document = extension(PROCEDURE_DEFINITION, payload);
  const retained = authoredDocumentBody({ document });
  expect<unknown>(retained.document?.doc.content?.[0]?.attrs?.payload).toEqual(payload);
  expect(contentDocumentNodes(document).filter(node => node.type === 'extensionInline')).toHaveLength(1);
  const list = procedureProjection(payload)['https://schema.org/itemListElement'] as { '@list': { '@id': string }[] };
  expect(list['@list'].map(item => item['@id'])).toEqual(['before', 'section', 'empty']);
});

test('Content refuses invalid known payloads on save, including nested procedures and finite capacity overflow', () => {
  const duplicate = procedure(); duplicate.items[1]!.id = 'before';
  const nested = procedure(); nested.items[0] = { id: 'before', type: 'HowToStep', document: extension(PROCEDURE_DEFINITION, procedure()) };
  const tooMany: ProcedurePayload = { items: Array.from({ length: 129 }, (_, n) => ({ id: String(n), type: 'HowToStep', document: fromPlainText('step', 'blocks') })) };
  let deep: ProcedurePayload = { items: [] };
  for (let n = 0; n < 17; n++) deep = { items: [{ id: String(n), type: 'HowToSection', name: { value: 'Section', language: 'en' }, items: deep.items }] };
  for (const payload of [duplicate, nested, tooMany, deep, { items: [], hidden: true }, { items: 'wrong' }])
    expect(() => authoredDocumentBody({ document: extension(PROCEDURE_DEFINITION, payload) })).toThrow();
  expect(() => checkedProcedure({ items: [{ id: 'big', type: 'HowToStep', document: fromPlainText('a'.repeat(262_144), 'blocks') }] })).toThrow();
  const inline = extension(PROCEDURE_DEFINITION, procedure(), true);
  expect(() => authoredDocumentBody({ document: inline })).toThrow();
  for (const value of ['\0', '\uD800', 'a'.repeat(65_537)]) {
    expect(() => checkedProcedure({ items: [{ id: 'invalid-step', type: 'HowToStep', document: fromPlainText(value, 'blocks') }] })).toThrow();
  }
});

test('media inside a procedure participates in the same exact Media Use checks', () => {
  const payload = procedure(); const document = structuredClone(fromPlainText('', 'blocks'));
  document.doc.content![0] = { type: 'image', attrs: { id: revision, src: '/v1/media/representations/image/bytes',
    representationId: revision, mediaUseId: revision } };
  payload.items[0] = { id: 'image-step', type: 'HowToStep', document };
  expect(documentImageUses(extension(PROCEDURE_DEFINITION, payload))).toEqual([
    { use: revision, representation: revision, occurrence: revision, conceal: false },
  ]);
  document.doc.content![0]!.attrs!.mediaUseId = null;
  expect(() => documentImageUses(extension(PROCEDURE_DEFINITION, payload))).toThrow();
});

test('Resource mentions keep fallback and refuse mismatched selector syntax without changing Work references', () => {
  for (const inline of [false, true]) expect(authoredDocumentBody({ document: extension(RESOURCE_REFERENCE_DEFINITION, ref, inline) }).body)
    .toBe(inline ? 'Reference fallback' : 'Instruction fallback');
  for (const selector of [{ grain: 'latest' }, { grain: 'resource', revision }, { grain: 'content', revision },
    { grain: 'revision', revision }, { grain: 'representation', revision, representation: revision }])
    expect(() => checkedResourceReference({ target: id(1), selector })).toThrow();
  expect(() => checkedResourceReference({ target: id(1), selector: { grain: 'resource' } }, true)).toThrow();
});

test('exact Content resolution pins the variant and revision, validates block spans, and conceals refused identities', async () => {
  const document = structuredClone(fromPlainText('Pinned instruction', 'blocks')); document.doc.content![0]!.attrs!.id = 'step';
  const calls: string[][] = [];
  const owners: ReferenceOwners = { resource: async () => false, revision: async () => false,
    occurrence: async () => false, representation: async () => null,
    content: async (...ids) => { calls.push(ids); return ids[2] === revision ? { document, body: 'Pinned instruction' } : null; } };
  const selection: ResourceReference = { ...ref, selector: { ...ref.selector as Extract<ResourceReference['selector'], { grain: 'content' }>, block: 'step', span: { start: 0, end: 6 } } };
  expect(await resolveResourceReference(selection, owners)).toMatchObject({ status: 'available', reference: selection, text: 'Pinned' });
  expect(calls[0]).toEqual([ref.target, 'urn:rezics:variant:00000000-0000-4000-8000-000000000002', revision]);
  expect(await resolveResourceReference({ ...ref, selector: { ...selection.selector as Extract<ResourceReference['selector'], { grain: 'content' }>, block: 'missing' } }, owners)).toEqual({ status: 'unavailable' });
  expect(await resolveResourceReference(ref, { ...owners, content: async () => null })).toEqual({ status: 'unavailable' });
  expect(await resolveResourceReference({ target: id(99), selector: { grain: 'resource' } }, owners)).toEqual({ status: 'unavailable' });
});

test('representation fragments must belong to the exact retained duration', async () => {
  const reference: ResourceReference = { target: `urn:rezics:media:asset:${revision}`,
    selector: { grain: 'representation', revision, representation: revision, fragment: 't=npt:0,1' } };
  const owners: ReferenceOwners = { resource: async () => false, revision: async () => false,
    occurrence: async () => false, content: async () => null, representation: async () => ({ duration: 1 }) };
  expect((await resolveResourceReference(reference, owners)).status).toBe('available');
  for (const duration of [0.5, undefined]) expect(await resolveResourceReference(reference,
    { ...owners, representation: async () => ({ duration }) })).toEqual({ status: 'unavailable' });
  expect(await resolveResourceReference({ ...reference, selector: { ...reference.selector as Extract<ResourceReference['selector'], { grain: 'representation' }>, fragment: 't=npt:1,0' } }, owners))
    .toEqual({ status: 'unavailable' });
});

test('Content span selectors count Unicode code points and ambiguous nested block IDs refuse', async () => {
  const document = structuredClone(fromPlainText('A😀B', 'blocks')); document.doc.content![0]!.attrs!.id = 'emoji';
  const owners: ReferenceOwners = { resource: async () => false, revision: async () => false, occurrence: async () => false,
    representation: async () => null, content: async () => ({ document, body: 'A😀B' }) };
  const reference: ResourceReference = { ...ref, selector: { ...ref.selector as Extract<ResourceReference['selector'], { grain: 'content' }>,
    block: 'emoji', span: { start: 1, end: 2 } } };
  expect(await resolveResourceReference(reference, owners)).toMatchObject({ status: 'available', text: '😀' });
  expect(await resolveResourceReference({ ...reference, selector: { ...reference.selector as Extract<ResourceReference['selector'], { grain: 'content' }>,
    span: { start: 3, end: 4 } } }, owners)).toEqual({ status: 'unavailable' });
  const payload: ProcedurePayload = { items: ['one', 'two'].map(id => ({ id, type: 'HowToStep', document })) };
  const ambiguous = extension(PROCEDURE_DEFINITION, payload);
  expect(await resolveResourceReference(reference, { ...owners, content: async () => ({ document: ambiguous, body: 'fallback' }) }))
    .toEqual({ status: 'unavailable' });
});

test('derivations require exact inputs and output, and project qualified PROV without authority claims', () => {
  const input: ContentDerivationInput = { output: ref as ContentDerivationInput['output'], inputs: [ref],
    activity: { kind: 'transformation' }, responsibleAgent: id(4), expectedOutputHead: revision };
  expect(checkedDerivation(input)).toBe(input);
  for (const bad of [{ ...input, inputs: [] }, { ...input, inputs: [{ target: id(5), selector: { grain: 'resource' } }] },
    { ...input, expectedOutputHead: 'wrong' }, { ...input, activity: { kind: 'equivalent' } }])
    expect(() => checkedDerivation(bad as ContentDerivationInput)).toThrow();
  const projection = derivationProjection({ derivation: 'urn:rezics:derivation:test', output: input.output, inputs: input.inputs,
    activity: { id: 'urn:rezics:activity:test', kind: input.activity.kind }, responsibleAgent: id(4), responsibleAgentType: 'software' });
  expect(JSON.stringify(projection)).toContain('http://www.w3.org/ns/prov#qualifiedDerivation');
  expect(JSON.stringify(projection)).toContain('http://www.w3.org/ns/prov#SoftwareAgent');
  expect(JSON.stringify(projection)).not.toMatch(/equivalen|authority|clearance|principal/);
});
