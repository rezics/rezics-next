import * as v from 'valibot';
import { createModerationIntent } from '../../moderation/command-intent';
import { classificationPair } from './inventory';
import type { ClassificationSetBody, OwnClassification, OwnClassificationsRead } from './types';

const id = v.pipe(v.string(), v.uuid());
const revision = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const schema = v.strictObject({
  viewer: id, subjectId: id, associationId: id,
  method: v.picklist(['PUT', 'DELETE']), path: v.pipe(v.string(), v.maxLength(256)),
  precondition: revision, key: id, csrfToken: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  credential: digest, observation: digest, locale: v.pipe(v.string(), v.minLength(1), v.maxLength(35)),
  readback: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  body: v.nullable(v.strictObject({ assessment: v.picklist(['support', 'oppose']), falsePositive: v.boolean() })),
  serializedBody: v.nullable(v.pipe(v.string(), v.maxLength(128))),
});
export type ClassificationIntent = Readonly<v.InferOutput<typeof schema>>;

export function classificationAssessmentPath(row: { subjectId: string; associationId: string }) {
  return `/v1/subjects/${row.subjectId}/classification-associations/${row.associationId}/assessment`;
}

export function classificationActionAllowed(row: OwnClassification, method: 'PUT' | 'DELETE') {
  const actions = row.actions;
  const base = classificationAssessmentPath(row);
  const exact = `${base}?expectedRevision=${row.own.revision}`;
  if (method === 'PUT')
    return row.state === 'available' && actions.state === 'editable' && actions.set === exact && actions.readback === base;
  return (actions.state === 'editable' || actions.state === 'withdraw-only') && actions.clear === exact &&
    (row.state === 'available' ? actions.readback === base : actions.readback === null && actions.set === null);
}

/** The native advice is captured once. Retry never derives operands from a newer summary or page. */
export function captureClassificationIntent(
  read: Extract<OwnClassificationsRead, { state: 'ready' }>,
  row: OwnClassification,
  method: 'PUT' | 'DELETE',
  csrfToken: string,
  body: ClassificationSetBody | null = null,
): ClassificationIntent {
  if (!read.page.items.includes(row) || !classificationActionAllowed(row, method) ||
    (method === 'PUT' ? body === null : body !== null)) throw new Error('Classification command unavailable');
  const intent = {
    viewer: read.subject, subjectId: row.subjectId, associationId: row.associationId, method,
    path: (method === 'PUT' ? row.actions.set : row.actions.clear)!, precondition: row.own.revision,
    key: createModerationIntent().keyFor([read.observation, classificationPair(row), method, body]),
    csrfToken, credential: read.credential, observation: read.observation, locale: read.locale,
    readback: row.actions.readback, body: body ? Object.freeze({ ...body }) : null,
    serializedBody: body ? JSON.stringify({ assessment: body.assessment, falsePositive: body.falsePositive }) : null,
  };
  return parseClassificationIntent(intent);
}

export function parseClassificationIntent(value: unknown): ClassificationIntent {
  const intent = v.parse(schema, value);
  const base = classificationAssessmentPath(intent);
  if (intent.path !== `${base}?expectedRevision=${intent.precondition}` ||
    (intent.readback !== null && intent.readback !== base) ||
    (intent.method === 'PUT' ? intent.body === null || intent.readback === null : intent.body !== null) ||
    (intent.body === null ? intent.serializedBody !== null : JSON.stringify(intent.body) !== intent.serializedBody))
    throw new Error('Invalid exact classification command');
  return Object.freeze({ ...intent, body: intent.body ? Object.freeze({ ...intent.body }) : null });
}
