import { Type, type TSchema } from 'typebox';
import { ZONE_EVENTS } from '../zones/events.ts';
import { Compile, type Validator } from 'typebox/compile';
import { ACCESS_EVENTS } from '../access/events.ts';
import { COMMERCE_EVENTS } from '../commerce/events.ts';
import { COMMUNITY_EVENTS } from '../community/events.ts';
import { CONTENT_EVENTS } from '../content/events.ts';
import { LIBRARY_EVENTS } from '../library/events.ts';
import { RATING_EVENTS } from '../rating/events.ts';
import { SEMANTIC_EVENTS } from '../semantic/events.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const digest = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
const productEventTypes = {
  ...ZONE_EVENTS,
  ...ACCESS_EVENTS,
  ...COMMERCE_EVENTS,
  ...COMMUNITY_EVENTS,
  ...CONTENT_EVENTS,
  ...LIBRARY_EVENTS,
  ...RATING_EVENTS,
  ...SEMANTIC_EVENTS,
  'com.rezics.definitions.published.v1': Type.Object({ digest }, { additionalProperties: false }),
  'com.rezics.definitions.activated.v1': Type.Object(
    { digest, head: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.presentation.profile.published.v1': Type.Object({ digest }, { additionalProperties: false }),
  'com.rezics.presentation.profile.activated.v1': Type.Object(
    { digest, head: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.subject.created.v1': Type.Object({ id: Type.String({ pattern: UUID }) }, { additionalProperties: false }),
  'com.rezics.subject.visibility_changed.v1': Type.Object(
    {
      id: Type.String({ pattern: UUID }),
      visibility: Type.Union([Type.Literal('visible'), Type.Literal('hidden'), Type.Literal('taken_down')]),
      security_revision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.subject.statement_visibility_changed.v1': Type.Object(
    {
      id: Type.String({ pattern: UUID }),
      candidate: Type.String({ pattern: UUID }),
      visibility: Type.Union([Type.Literal('visible'), Type.Literal('hidden'), Type.Literal('taken_down')]),
      security_revision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  'com.rezics.semantic.context.created.v1': Type.Object(
    { id: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
} as const;

const schemas: Record<string, TSchema> = Object.create(null);
const validators = new Map<string, Validator>();
let sealed = false;

/** Schema view retained for consumers that inspect event contracts. */
export const EVENT_TYPES = schemas as Readonly<typeof productEventTypes> & Readonly<Record<string, TSchema>>;

/** Register startup-only event contracts, compiling each schema exactly once. */
export function registerEventTypes(entries: Readonly<Record<string, TSchema>>): void {
  if (sealed) throw new TypeError('The event catalogue is sealed after the first command commit');
  const pending = Object.entries(entries).map(([type, schema]) => {
    if (validators.has(type)) throw new TypeError(`Duplicate event type: ${type}`);
    return { type, schema, validator: Compile(schema) };
  });
  for (const { type, schema, validator } of pending) {
    Object.defineProperty(schemas, type, { value: schema, enumerable: true });
    validators.set(type, validator);
  }
}

export function lookupEventType(type: string): Validator | undefined {
  return validators.get(type);
}

/** Called only after a command transaction has committed successfully. */
export function sealEventTypes(): void {
  sealed = true;
  Object.freeze(schemas);
}

registerEventTypes(productEventTypes);
