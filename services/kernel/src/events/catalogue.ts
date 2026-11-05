import { memoizedValue } from '../memoized.ts';
import { RECENT_SEARCH_EVENTS } from '../search/query-events.ts';
import { TRENDING_SEARCH_EVENTS } from '../search/query-events.ts';
import { Type, type TSchema } from 'typebox';
import { ZONE_EVENTS } from '../zones/events.ts';
import { Compile, type Validator } from 'typebox/compile';
import { ACCESS_EVENTS } from '../access/events.ts';
import { COMMERCE_EVENTS } from '../commerce/events.ts';
import { COMMUNITY_EVENTS } from '../community/events.ts';
import { CONTENT_EVENTS } from '../content/events.ts';
import { REPORT_LOCATOR_EVENTS } from '../content/report-locator-events.ts';
import { LIBRARY_EVENTS } from '../library/events.ts';
import { RATING_EVENTS } from '../rating/events.ts';
import { SEMANTIC_EVENTS } from '../semantic/events.ts';
import { SEARCH_IDENTITY_EVENTS } from '../search/identity-epoch-participant-events.ts';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const digest = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
function productEventTypes() {
  return memoizedValue(
    productEventTypes,
    () =>
      ({
        'com.rezics.history.erasure-acknowledged.v1': Type.Object(
          {
            version: Type.Integer({ minimum: 1 }),
            outcome: Type.Union([Type.Literal('erased'), Type.Literal('none')]),
          },
          { additionalProperties: false },
        ),
        'com.rezics.history.minimized.v1': Type.Object({}, { additionalProperties: false }),
        ...RECENT_SEARCH_EVENTS,
        ...TRENDING_SEARCH_EVENTS,
        ...ZONE_EVENTS,
        ...ACCESS_EVENTS(),
        ...COMMERCE_EVENTS,
        ...COMMUNITY_EVENTS(),
        ...CONTENT_EVENTS(),
        ...REPORT_LOCATOR_EVENTS,
        ...LIBRARY_EVENTS,
        ...RATING_EVENTS(),
        ...SEMANTIC_EVENTS,
        ...SEARCH_IDENTITY_EVENTS,
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
        'com.rezics.subject.created.v1': Type.Object(
          { id: Type.String({ pattern: UUID }) },
          { additionalProperties: false },
        ),
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
      }) as const,
  );
}

type Catalogue = { schemas: Record<string, TSchema>; validators: Map<string, Validator>; sealed: boolean };

function catalogue(): Catalogue {
  return memoizedValue(catalogue, () => {
    const result: Catalogue = { schemas: Object.create(null), validators: new Map(), sealed: false };
    addEventTypes(result, productEventTypes());
    return result;
  });
}

/** Collect the declared producer contracts before process resources start. */
export function initializeEventTypes(): void {
  catalogue();
}

/** Schema view retained for consumers that inspect event contracts. */
export function EVENT_TYPES() {
  return memoizedValue(
    EVENT_TYPES,
    () => catalogue().schemas as Readonly<ReturnType<typeof productEventTypes>> & Readonly<Record<string, TSchema>>,
  );
}

function addEventTypes(target: Catalogue, entries: Readonly<Record<string, TSchema>>): void {
  if (target.sealed) throw new TypeError('The event catalogue is sealed after the first command commit');
  const pending = Object.entries(entries).map(([type, schema]) => {
    if (target.validators.has(type)) throw new TypeError(`Duplicate event type: ${type}`);
    return { type, schema, validator: Compile(schema) };
  });
  for (const { type, schema, validator } of pending) {
    Object.defineProperty(target.schemas, type, { value: schema, enumerable: true });
    target.validators.set(type, validator);
  }
}

/** Register startup-only event contracts, compiling each schema exactly once. */
export function registerEventTypes(entries: Readonly<Record<string, TSchema>>): void {
  addEventTypes(catalogue(), entries);
}

export function lookupEventType(type: string): Validator | undefined {
  return catalogue().validators.get(type);
}

/** Called only after a command transaction has committed successfully. */
export function sealEventTypes(): void {
  const value = catalogue();
  value.sealed = true;
  Object.freeze(value.schemas);
}
