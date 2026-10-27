// SPDX-License-Identifier: Apache-2.0
import canonicalize from 'canonicalize';
import {
  MAX_COMPOSITION_BYTES,
  MAX_COMPOSITION_DEPTH,
  MAX_COMPOSITION_NODES,
  type CompositionComponent,
  type CompositionDocument,
  type CompositionRegistry,
  type CompositionViolation,
  type CompositionViolationCode,
  type SchemaNode,
} from './registry.ts';
import { MAX_PAGE_COST, PageReadLimitError, planReads, readCost } from './reads.ts';
import { CURIE, HREF, LOCALE_KEY, MAX_LOCALIZED_ENTRIES, NODE_ID, PLAIN_TEXT, safetyKind } from './strings.ts';

const MAX_VIOLATIONS = 64;
const PRIORITY: Record<CompositionViolationCode, number> = {
  limit: 4,
  unsafe: 3,
  duplicate: 2,
  unknown_type: 2,
  invalid: 1,
};

type Add = (pointer: string, code: CompositionViolationCode) => void;

function token(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function join(pointer: string, segment: string | number): string {
  return `${pointer}/${typeof segment === 'number' ? segment : token(segment)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
      const previous = value.charCodeAt(index - 1)!;
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
    }
    length += 1;
  }
  return length;
}

function lengthOk(value: string, schema: SchemaNode): boolean {
  const length = codePointLength(value);
  if (schema.maxLength !== undefined && length > schema.maxLength) return false;
  if (schema.minLength !== undefined && length < schema.minLength) return false;
  return true;
}

function inRange(schema: SchemaNode, value: number): boolean {
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (schema.maximum !== undefined && value > schema.maximum) return false;
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
  return true;
}

function put(found: Map<string, CompositionViolationCode>, pointer: string, code: CompositionViolationCode): void {
  const current = found.get(pointer);
  if (current === undefined || PRIORITY[code] > PRIORITY[current]) found.set(pointer, code);
}

function finish(found: Map<string, CompositionViolationCode>): CompositionViolation[] {
  const violations = [...found.entries()].map(([pointer, code]) => ({ pointer, code }));
  violations.sort((left, right) => (left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0));
  return violations.slice(0, MAX_VIOLATIONS);
}

/** A value this large cannot have a canonical form within the byte budget. */
function provablyOverLimit(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.length > MAX_COMPOSITION_BYTES) return true;
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_COMPOSITION_BYTES) return true;
      for (let index = 0; index < current.length; index++) pending.push(current[index]);
      continue;
    }
    const keys = Object.keys(current);
    if (keys.length > MAX_COMPOSITION_BYTES) return true;
    for (const key of keys) {
      if (key.length > MAX_COMPOSITION_BYTES) return true;
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function patternOk(schema: SchemaNode, value: string): boolean {
  const kind = safetyKind(schema);
  if (kind === 'plainText') return PLAIN_TEXT.test(value);
  if (kind === 'href') return HREF.test(value);
  if (kind === 'curie') return CURIE.test(value);
  if (typeof schema.pattern !== 'string') return true;
  return new RegExp(schema.pattern, 'u').test(value);
}

function walkLocalized(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  const text = schema.anyOf?.[0];
  const map = schema.anyOf?.[1];
  if (text === undefined || map === undefined) {
    add(pointer, 'invalid');
    return;
  }
  if (typeof value === 'string') {
    walkString(text, value, pointer, add);
    return;
  }
  if (!isRecord(value)) {
    add(pointer, 'invalid');
    return;
  }
  const keys = Object.keys(value);
  const min = map.minProperties ?? 1;
  const max = map.maxProperties ?? MAX_LOCALIZED_ENTRIES;
  if (keys.length < min || keys.length > max) add(pointer, 'invalid');
  for (const key of keys) {
    const keyPointer = join(pointer, key);
    if (!LOCALE_KEY.test(key)) add(keyPointer, 'invalid');
    walkString(text, value[key], keyPointer, add);
  }
}

function walkSchema(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  if (safetyKind(schema) === 'localizedText') {
    walkLocalized(schema, value, pointer, add);
    return;
  }
  switch (schema['~kind']) {
    case 'Object':
      walkObject(schema, value, pointer, add);
      return;
    case 'Array':
      walkArray(schema, value, pointer, add);
      return;
    case 'Union':
      walkUnion(schema, value, pointer, add);
      return;
    case 'Literal':
      if (value !== schema.const) add(pointer, 'invalid');
      return;
    case 'String':
      walkString(schema, value, pointer, add);
      return;
    case 'Integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) add(pointer, 'invalid');
      else if (!inRange(schema, value)) add(pointer, 'limit');
      return;
    case 'Number':
      if (typeof value !== 'number' || !Number.isFinite(value)) add(pointer, 'invalid');
      else if (!inRange(schema, value)) add(pointer, 'limit');
      return;
    case 'Boolean':
      if (typeof value !== 'boolean') add(pointer, 'invalid');
      return;
    default:
      add(pointer, 'invalid');
  }
}

function walkObject(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  if (!isRecord(value)) {
    add(pointer, 'invalid');
    return;
  }
  const properties = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    const property = properties[key];
    if (property === undefined) {
      if (schema.additionalProperties === false) add(join(pointer, key), 'invalid');
      continue;
    }
    walkSchema(property, value[key], join(pointer, key), add);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) add(join(pointer, key), 'invalid');
  }
}

function walkArray(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  if (!Array.isArray(value)) {
    add(pointer, 'invalid');
    return;
  }
  if (
    (schema.maxItems !== undefined && value.length > schema.maxItems) ||
    (schema.minItems !== undefined && value.length < schema.minItems)
  ) {
    add(pointer, 'invalid');
  }
  if (schema.uniqueItems && new Set(value.map((item) => canonicalize(item))).size !== value.length) {
    add(pointer, 'invalid');
  }
  if (!schema.items) return;
  for (let index = 0; index < value.length; index++) walkSchema(schema.items, value[index], join(pointer, index), add);
}

function walkUnion(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  let best: CompositionViolation[] | undefined;
  for (const member of schema.anyOf ?? []) {
    const found = new Map<string, CompositionViolationCode>();
    walkSchema(member, value, pointer, (itemPointer, code) => put(found, itemPointer, code));
    if (found.size === 0) return;
    const violations = [...found.entries()].map(([itemPointer, code]) => ({ pointer: itemPointer, code }));
    if (best === undefined || violations.length < best.length) best = violations;
  }
  for (const violation of best ?? [{ pointer, code: 'invalid' as const }]) add(violation.pointer, violation.code);
}

function walkString(schema: SchemaNode, value: unknown, pointer: string, add: Add): void {
  if (typeof value !== 'string') {
    add(pointer, 'invalid');
    return;
  }
  // A string that fails a safety pattern is unsafe even when it is also too long.
  if (safetyKind(schema) && !patternOk(schema, value)) {
    add(pointer, 'unsafe');
    return;
  }
  if (!patternOk(schema, value) || !lengthOk(value, schema)) add(pointer, 'invalid');
}

interface PageState {
  ids: Set<string>;
  /** Pointers to the `level` of every level-1 `Heading`, in walk order. */
  headings: string[];
  subjectHeaders: number;
}

function recordId(value: unknown, pointer: string, seen: Set<string>, add: Add): void {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    add(pointer, 'invalid');
    return;
  }
  if (seen.has(value)) {
    add(pointer, 'duplicate');
    return;
  }
  seen.add(value);
}

function validateProps(
  components: ReadonlyMap<string, CompositionComponent>,
  component: CompositionComponent,
  props: Record<string, unknown>,
  pointer: string,
  page: PageState,
  add: Add,
): void {
  const schema = component.props as SchemaNode;
  const properties = schema.properties ?? {};
  const slots = new Set(component.slots);
  if (!Object.hasOwn(props, 'id')) add(join(pointer, 'id'), 'invalid');
  else recordId(props.id, join(pointer, 'id'), page.ids, add);
  for (const key of Object.keys(props)) {
    if (key !== 'id' && !slots.has(key) && properties[key] === undefined) add(join(pointer, key), 'invalid');
  }
  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(props, key)) {
      if ((schema.required ?? []).includes(key)) add(join(pointer, key), 'invalid');
      continue;
    }
    walkSchema(property, props[key], join(pointer, key), add);
  }
  if (component.type === 'SubjectHeader') page.subjectHeaders += 1;
  if (component.type === 'Heading' && props.level === 1) page.headings.push(join(pointer, 'level'));
  for (const slot of component.slots) {
    const slotPointer = join(pointer, slot);
    if (!Object.hasOwn(props, slot)) {
      add(slotPointer, 'invalid');
      continue;
    }
    const children = props[slot];
    if (!Array.isArray(children)) {
      add(slotPointer, 'invalid');
      continue;
    }
    for (let index = 0; index < children.length; index++) {
      validateNode(components, children[index], join(slotPointer, index), page, add);
    }
  }
}

function validateNode(
  components: ReadonlyMap<string, CompositionComponent>,
  value: unknown,
  pointer: string,
  page: PageState,
  add: Add,
): void {
  if (!isRecord(value)) {
    add(pointer, 'invalid');
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'props') add(join(pointer, key), 'invalid');
  }
  if (!Object.hasOwn(value, 'type')) add(join(pointer, 'type'), 'invalid');
  if (!Object.hasOwn(value, 'props')) add(join(pointer, 'props'), 'invalid');
  if (typeof value.type !== 'string') {
    if (Object.hasOwn(value, 'type')) add(join(pointer, 'type'), 'invalid');
    return;
  }
  const component = components.get(value.type);
  if (component === undefined) {
    add(join(pointer, 'type'), 'unknown_type');
    return;
  }
  if (!isRecord(value.props)) {
    if (Object.hasOwn(value, 'props')) add(join(pointer, 'props'), 'invalid');
    return;
  }
  validateProps(components, component, value.props, join(pointer, 'props'), page, add);
}

function validateDocument(registry: CompositionRegistry, value: unknown, add: Add): void {
  if (!isRecord(value)) {
    add('', 'invalid');
    return;
  }
  const components = new Map(registry.components.map((component) => [component.type, component]));
  const page: PageState = { ids: new Set(), headings: [], subjectHeaders: 0 };
  for (const key of Object.keys(value)) {
    if (key !== 'root' && key !== 'content') add(join('', key), 'invalid');
  }
  if (!Object.hasOwn(value, 'root')) add('/root', 'invalid');
  else validateRoot(registry.root as SchemaNode, value.root, add);
  if (!Object.hasOwn(value, 'content')) add('/content', 'invalid');
  else if (!Array.isArray(value.content)) add('/content', 'invalid');
  else {
    for (let index = 0; index < value.content.length; index++) {
      validateNode(components, value.content[index], `/content/${index}`, page, add);
    }
    // A subject header is the page heading, so it leaves no room for a level-1 heading; otherwise the first one is.
    if (page.subjectHeaders <= 1) {
      for (const pointer of page.subjectHeaders === 1 ? page.headings : page.headings.slice(1))
        add(pointer, 'duplicate');
    }
  }
}

function validateRoot(schema: SchemaNode, value: unknown, add: Add): void {
  if (!isRecord(value)) {
    add('/root', 'invalid');
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'props') add(join('/root', key), 'invalid');
  }
  if (!Object.hasOwn(value, 'props')) {
    add('/root/props', 'invalid');
    return;
  }
  walkSchema(schema, value.props, '/root/props', add);
}

interface Frame {
  items: unknown[];
  index: number;
  depth: number;
  base: string;
}

function limitViolation(registry: CompositionRegistry, value: unknown): CompositionViolation | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const components = new Map(registry.components.map((component) => [component.type, component]));
  const stack: Frame[] = [{ items: value.content, index: 0, depth: 1, base: '/content' }];
  let count = 0;
  let depthPointer: string | undefined;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.items.length) {
      stack.pop();
      continue;
    }
    const index = frame.index++;
    count += 1;
    const pointer = `${frame.base}/${index}`;
    if (frame.depth > MAX_COMPOSITION_DEPTH && depthPointer === undefined) depthPointer = pointer;
    // The node budget is the whole tree, so it wins over a depth violation.
    if (count > MAX_COMPOSITION_NODES) return { pointer: '/content', code: 'limit' };
    const node = frame.items[index];
    if (!isRecord(node) || typeof node.type !== 'string' || !isRecord(node.props)) continue;
    const component = components.get(node.type);
    if (component === undefined) continue;
    const nested: Frame[] = [];
    for (const slot of component.slots) {
      const children = node.props[slot];
      if (Array.isArray(children)) {
        nested.push({ items: children, index: 0, depth: frame.depth + 1, base: `${pointer}/props/${token(slot)}` });
      }
    }
    for (let slotIndex = nested.length - 1; slotIndex >= 0; slotIndex--) stack.push(nested[slotIndex]!);
  }
  if (depthPointer !== undefined) return { pointer: depthPointer, code: 'limit' };
  return undefined;
}

function canonicalBytes(value: unknown): number | undefined {
  const text = canonicalize(value);
  return typeof text === 'string' ? new TextEncoder().encode(text).byteLength : undefined;
}

/** Pure publish-time check. Parsed JSON does not throw, and the input is not mutated. */
export function validateComposition(registry: CompositionRegistry, value: unknown): CompositionViolation[] {
  try {
    if (provablyOverLimit(value)) return [{ pointer: '', code: 'limit' }];
    const bytes = canonicalBytes(value);
    if (bytes === undefined) return [{ pointer: '', code: 'invalid' }];
    if (bytes > MAX_COMPOSITION_BYTES) return [{ pointer: '', code: 'limit' }];
  } catch {
    return [{ pointer: '', code: 'invalid' }];
  }
  const limit = limitViolation(registry, value);
  if (limit) return [limit];
  const found = new Map<string, CompositionViolationCode>();
  validateDocument(registry, value, (pointer, code) => put(found, pointer, code));
  if (found.size === 0) {
    try {
      const plan = planReads(registry, value as CompositionDocument, {
        subject: '00000000-0000-8000-8000-000000000000',
        account: { id: '00000000-0000-8000-8000-000000000000', handle: 'placeholder' },
      });
      let cost = 0;
      for (const read of Object.values(plan.reads)) cost += readCost(read);
      if (cost > MAX_PAGE_COST) return [{ pointer: '/content', code: 'limit' }];
    } catch (error) {
      if (error instanceof PageReadLimitError) return [{ pointer: '/content', code: 'limit' }];
      throw error;
    }
  }
  return finish(found);
}
