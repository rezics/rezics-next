import { t, type Context } from 'elysia';
import { problemResult } from '../api-contract.ts';

export type ProblemSet = Context['set'];

/** A domain's public identity supplies both the native reply and its runtime schema. */
export function problemDefinition<const Status extends number, const Code extends string>(
  status: Status, code: Code, title: string,
) {
  return {
    status, code,
    body: { type: `https://rezics.com/problems/${code}`, title, status, code },
    schema: t.Object({ ...problemResult(status).properties, code: t.Literal(code) },
      { additionalProperties: false }),
  } as const;
}

export const invalidRequest = problemDefinition(400, 'invalid_request', 'Request does not match the Work contract');
export const internalError = problemDefinition(500, 'internal_error', 'Request could not be processed');
export const dependencyUnavailable = problemDefinition(503, 'dependency_unavailable', 'Work operation could not be completed');

/** Compatibility for routes outside the native-return pilot. */
export function legacyFailureResponse(failure: { status: number; response: unknown }, set: ProblemSet) {
  const headers = new Headers({ 'content-type': failure.status >= 400 ? 'application/problem+json' : 'application/json',
    'cache-control': 'no-store' });
  for (const [key, value] of Object.entries(set.headers)) {
    if (value !== undefined) {
      headers.delete(key);
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, String(item));
    }
  }
  return Response.json(failure.response, { status: failure.status, headers });
}
