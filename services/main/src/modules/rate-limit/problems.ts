import { t } from 'elysia';
import { problemDefinition } from '../problem.ts';

export const rateLimited = problemDefinition(429, 'rate_limited', 'Request budget exhausted');
export const rateLimitUnavailable = problemDefinition(503, 'rate_limit_unavailable', 'Request budget unavailable');
export const rateLimitUnclassified = problemDefinition(503, 'rate_limit_unclassified', 'Request budget policy unavailable');
export const rateLimitedSchema = t.Object({ ...rateLimited.schema.properties,
  family: t.String() }, { additionalProperties: false });
