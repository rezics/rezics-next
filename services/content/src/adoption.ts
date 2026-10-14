import { documentText, parseDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { canonicalContentLanguage } from './language.ts';
import { checkedContentText } from './text.ts';

export const PROCEDURE_DEFINITION = 'https://rezics.com/definition/procedure-v1';
export const RESOURCE_REFERENCE_DEFINITION = 'https://rezics.com/definition/resource-reference-v1';
export const PROCEDURE_COST = { items: 128, sectionLevels: 16, bytes: 262_144 } as const;
export type ResourceSelector =
  | { grain: 'resource' }
  | { grain: 'revision'; revision: string }
  | { grain: 'occurrence'; structure: string; revision: string; occurrence: string }
  // TextPositionSelector counts Unicode code points, independently of text API cost units.
  | { grain: 'content'; variantId: string; revision: string; block?: string; span?: { start: number; end: number } }
  | { grain: 'representation'; revision: string; representation: string; fragment?: string };
export interface ResourceReference { target: string; selector: ResourceSelector }
export interface ContentSelection extends ResourceReference { selector: Extract<ResourceSelector, { grain: 'content' }> }
export type ProcedureItem =
  | { id: string; type: 'HowToStep'; document: DocumentSnapshot }
  | { id: string; type: 'HowToSection'; name: { value: string; language: string }; items: ProcedureItem[] };
export interface ProcedurePayload { items: ProcedureItem[] }
export class ContentAdoptionInvalid extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContentAdoptionInvalid('expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ContentAdoptionInvalid('unsupported selection field');
}
function text(value: unknown, limit = 256): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > limit || value.includes('\0'))
    throw new ContentAdoptionInvalid('invalid selection identity');
}
function identifier(value: unknown) {
  text(value, 2048);
  if (!/^(?:https:\/\/rezics\.com\/id\/|urn:rezics:)[^\s<>"{}]+$/.test(value))
    throw new ContentAdoptionInvalid('invalid Resource identity');
}
function revision(value: unknown, content = false) {
  if (content) { if (typeof value !== 'string' || !uuid.test(value)) throw new ContentAdoptionInvalid('invalid exact revision'); }
  else identifier(value);
}
/** Structural admission never fetches a target or upgrades a selection to latest. */
export function checkedResourceReference(value: unknown, exact = false): ResourceReference {
  const ref = object(value); keys(ref, ['target', 'selector']); identifier(ref.target);
  const selector = object(ref.selector);
  switch (selector.grain) {
    case 'resource': keys(selector, ['grain']); if (exact) throw new ContentAdoptionInvalid('an exact input is required'); break;
    case 'revision': keys(selector, ['grain', 'revision']); revision(selector.revision); break;
    case 'occurrence': keys(selector, ['grain', 'structure', 'revision', 'occurrence']);
      identifier(selector.structure); revision(selector.revision); identifier(selector.occurrence); break;
    case 'content': keys(selector, ['grain', 'variantId', 'revision', 'block', 'span']);
      if (typeof selector.variantId !== 'string' || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(selector.variantId))
        throw new ContentAdoptionInvalid('invalid Content variant');
      revision(selector.revision, true);
      if (selector.block !== undefined) text(selector.block);
      if (selector.span !== undefined) {
        const span = object(selector.span); keys(span, ['start', 'end']);
        if (!selector.block || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
          || (span.start as number) < 0 || (span.end as number) <= (span.start as number))
          throw new ContentAdoptionInvalid('invalid block span');
      }
      break;
    case 'representation': keys(selector, ['grain', 'revision', 'representation', 'fragment']);
      revision(selector.revision, true); revision(selector.representation, true);
      if (typeof ref.target !== 'string' || !/^urn:rezics:media:asset:[0-9a-f-]{36}$/.test(ref.target))
        throw new ContentAdoptionInvalid('representation requires a Media asset');
      if (selector.fragment !== undefined && (typeof selector.fragment !== 'string'
        || !/^t=npt:\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(selector.fragment)))
        throw new ContentAdoptionInvalid('invalid temporal fragment');
      break;
    default: throw new ContentAdoptionInvalid('unsupported Resource grain');
  }
  return value as ResourceReference;
}

/** Procedure step documents stay in the ordinary document model. No second editable projection. */
export function checkedProcedure(value: unknown): ProcedurePayload {
  const payload = object(value); keys(payload, ['items']);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PROCEDURE_COST.bytes)
    throw new ContentAdoptionInvalid('procedure exceeds byte bound');
  const ids = new Set<string>(); let count = 0;
  const visit = (items: unknown, depth: number): void => {
    if (!Array.isArray(items)) throw new ContentAdoptionInvalid('procedure items must be ordered');
    for (const value of items) {
      const item = object(value); text(item.id);
      if (++count > PROCEDURE_COST.items || ids.has(item.id)) throw new ContentAdoptionInvalid('procedure item bound or duplicate ID');
      ids.add(item.id);
      if (item.type === 'HowToStep') {
        keys(item, ['id', 'type', 'document']); const document = parseDocument(item.document);
        if (document.profile !== 'blocks') throw new ContentAdoptionInvalid('step requires a Blocks document');
        checkedContentText(documentText(document));
        validateContentExtensions(document, true);
      } else if (item.type === 'HowToSection') {
        keys(item, ['id', 'type', 'name', 'items']);
        if (depth >= PROCEDURE_COST.sectionLevels) throw new ContentAdoptionInvalid('procedure section depth exceeded');
        const name = object(item.name); keys(name, ['value', 'language']); text(name.value, 200); text(name.language, 100);
        if (canonicalContentLanguage(name.language) !== name.language) throw new ContentAdoptionInvalid('section language must be canonical');
        visit(item.items, depth + 1);
      } else throw new ContentAdoptionInvalid('unsupported procedure item');
    }
  };
  visit(payload.items, 0); return value as ProcedurePayload;
}

export function validateContentExtensions(document: DocumentSnapshot, inProcedure = false): void {
  const pending = [document.doc];
  while (pending.length) {
    const node = pending.pop()!; const attrs = node.attrs;
    if (node.type === 'extensionBlock' || node.type === 'extensionInline') {
      if (attrs?.definition === PROCEDURE_DEFINITION) {
        if (inProcedure || node.type !== 'extensionBlock' || attrs.version !== '1')
          throw new ContentAdoptionInvalid('nested or unsupported procedure');
        checkedProcedure(attrs.payload);
      } else if (attrs?.definition === RESOURCE_REFERENCE_DEFINITION) {
        if (attrs.version !== '1') throw new ContentAdoptionInvalid('unsupported reference version');
        checkedResourceReference(attrs.payload);
      }
    }
    pending.push(...node.content ?? []);
  }
}

/** Include known step documents in owner walks, without recursively expanding references. */
export function contentDocumentNodes(document: DocumentSnapshot): DocumentNode[] {
  validateContentExtensions(document);
  const result: DocumentNode[] = []; const pending = [document.doc];
  while (pending.length) {
    const node = pending.pop()!; result.push(node); pending.push(...node.content ?? []);
    if (node.attrs?.definition === PROCEDURE_DEFINITION) {
      const visit = (items: ProcedureItem[]) => { for (const item of items)
        if (item.type === 'HowToStep') pending.push(item.document.doc); else visit(item.items); };
      visit(checkedProcedure(node.attrs.payload).items);
    }
  }
  return result;
}

export function procedureProjection(payload: ProcedurePayload): Record<string, unknown> {
  checkedProcedure(payload);
  const project = (item: ProcedureItem): Record<string, unknown> => item.type === 'HowToSection'
    ? { '@type': 'https://schema.org/HowToSection', '@id': item.id,
      'https://schema.org/name': { '@value': item.name.value, '@language': item.name.language },
      'https://schema.org/itemListElement': { '@list': item.items.map(project) } }
    : { '@type': 'https://schema.org/HowToStep', '@id': item.id,
      'https://schema.org/text': documentText(item.document), document: item.document };
  return { 'https://schema.org/itemListElement': { '@list': payload.items.map(project) } };
}

/** Web Annotation projection describes a selection; it never asserts equivalence or grants access. */
export function resourceReferenceProjection(reference: ResourceReference): Record<string, unknown> {
  checkedResourceReference(reference);
  const oa = 'http://www.w3.org/ns/oa#', s = reference.selector;
  if (s.grain === 'resource') return { '@id': reference.target };
  const selectedRevision = s.grain === 'content' || s.grain === 'representation'
    ? `urn:rezics:${s.grain === 'content' ? 'content' : 'media'}:revision:${s.revision}` : s.revision;
  const selector = s.grain === 'occurrence' ? { '@type': `${oa}FragmentSelector`,
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#value': s.occurrence }
    : s.grain === 'representation' && s.fragment ? { '@type': `${oa}FragmentSelector`,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#value': s.fragment,
      'http://purl.org/dc/terms/conformsTo': { '@id': 'http://www.w3.org/TR/media-frags/' } }
      : s.grain === 'content' && s.block ? { '@type': `${oa}FragmentSelector`,
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#value': s.block,
        ...(s.span ? { [`${oa}refinedBy`]: { '@type': `${oa}TextPositionSelector`, [`${oa}start`]: s.span.start, [`${oa}end`]: s.span.end } } : {}) } : undefined;
  return { '@type': `${oa}SpecificResource`, [`${oa}hasSource`]: { '@id': reference.target },
    [`${oa}hasState`]: { '@type': `${oa}TimeState`, [`${oa}cachedSource`]: { '@id': selectedRevision } },
    ...(s.grain === 'content' ? { variantId: s.variantId } : {}),
    ...(s.grain === 'occurrence' ? { structure: { '@id': s.structure } } : {}),
    ...(s.grain === 'representation' ? { representation: { '@id': `urn:rezics:media:representation:${s.representation}` } } : {}),
    ...(selector ? { [`${oa}hasSelector`]: selector } : {}) };
}
