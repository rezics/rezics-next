import { problem } from 'elysia';
import { problemDefinition } from '../problem.ts';
import { ActingContextDenied, ActingContextInvalid, ActingContextStale, ActingContextUnavailable } from './contexts.ts';

export const actingContextInvalid = problemDefinition(400, 'invalid_request', 'Acting context request is invalid');
export const actingContextDenied = problemDefinition(403, 'acting_context_denied', 'Selected Agent is unavailable for this task');
export const actingContextStale = problemDefinition(409, 'stale_context', 'Acting context authority changed');
export const actingContextUnavailable = problemDefinition(503, 'acting_context_unavailable', 'Acting contexts are unavailable');

export const actingContextProblemSchemas = {
  400: actingContextInvalid.schema, 403: actingContextDenied.schema,
  409: actingContextStale.schema, 503: actingContextUnavailable.schema,
};

export function actingContextFailure(error: unknown) {
  if (error instanceof ActingContextInvalid) return problem(actingContextInvalid.body);
  if (error instanceof ActingContextDenied) return problem(actingContextDenied.body);
  if (error instanceof ActingContextStale) return problem(actingContextStale.body);
  if (error instanceof ActingContextUnavailable) return problem(actingContextUnavailable.body);
}
