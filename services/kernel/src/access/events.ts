import { Type } from 'typebox';
import governance from './platform-governance.json';

/** Public bootstrap audit; private account and operator configuration never enter the log. */
export const ACCESS_EVENTS = {
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
