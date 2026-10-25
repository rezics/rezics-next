import { Type } from 'typebox';
import governance from './platform-governance.json';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const identity = Type.String({ pattern: `^${uuid}$`, minLength: 36, maxLength: 36 });
const resource = Type.Object(
  { route: Type.Integer({ minimum: 0, maximum: 65535 }), id: identity },
  { additionalProperties: false },
);
const subject = Type.Union([
  Type.Object({ kind: Type.Literal('active_accounts') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('account'), id: identity }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('organization'),
      id: identity,
      role: Type.Union([Type.Literal('owner'), Type.Literal('member')]),
    },
    { additionalProperties: false },
  ),
]);
const grantFields = {
  resource,
  actions: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$(?![\\s\\S])' }), { minItems: 1 }),
  // Commands return the supplied PostgreSQL range text, not a normalized timestamp.
  valid: Type.String(),
};
const grant = Type.Union([
  Type.Object({ ...grantFields, subject }, { additionalProperties: false }),
  Type.Object(
    {
      ...grantFields,
      subjectId: identity,
      subjectRole: Type.Union([Type.Literal(''), Type.Literal('owner'), Type.Literal('member')]),
    },
    { additionalProperties: false },
  ),
]);
const roleGrant = Type.Object(
  { resource, subject, role: Type.String({ pattern: '^[a-z][a-z0-9_.-]*$(?![\\s\\S])' }), valid: Type.String() },
  { additionalProperties: false },
);
const assignment = Type.Object(
  { requestedBy: Type.String({ pattern: `^urn:rezics:request:${uuid}:${uuid}$`, minLength: 92, maxLength: 92 }) },
  { additionalProperties: false },
);

/** Exact public command return values; command keys, credentials and opening context stay private. */
export const ACCESS_EVENTS = {
  'com.rezics.access.grant.create.v1': grant,
  'com.rezics.access.grant.change.v1': grant,
  'com.rezics.access.grant.revoke.v1': grant,
  'com.rezics.access.role-grant.create.v1': roleGrant,
  'com.rezics.access.role-grant.change.v1': roleGrant,
  'com.rezics.access.role-grant.revoke.v1': roleGrant,
  'com.rezics.access.assignment.create.v1': assignment,
  'com.rezics.access.assignment.revoke.v1': assignment,
  'com.rezics.access.governance.bootstrapped.v1': Type.Object(
    {
      accountId: Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
      resource: Type.Object(
        { route: Type.Literal(0), id: Type.Literal('00000000-0000-8000-8000-000000000000') },
        { additionalProperties: false },
      ),
      role: Type.Literal(governance.role),
    },
    { additionalProperties: false },
  ),
} as const;
