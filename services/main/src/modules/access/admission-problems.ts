import { problem, t } from 'elysia';
import { dependencyUnavailable, problemDefinition, type ProblemSet } from '../problem.ts';
import { AdmissionConflict, AdmissionControllerContinuity, AdmissionDenied,
  AdmissionLockBusy, AdmissionUnavailable } from './admission.ts';

export const authorityDenied = problemDefinition(403, 'authority_denied', 'Authority is not admitted');
export const idempotencyConflict = problemDefinition(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
export const admissionBusy = problemDefinition(409, 'admission_busy', 'Access admission is busy; retry the same request');
export const controllerContinuity = problemDefinition(409, 'controller_continuity', 'This change would leave a resource without a controller');
export const admissionConflictSchema = t.Union([idempotencyConflict.schema, admissionBusy.schema, controllerContinuity.schema]);

export function authorityFailure(error: unknown, set: ProblemSet) {
  if (error instanceof AdmissionDenied) return problem(authorityDenied.body);
  if (error instanceof AdmissionUnavailable) {
    set.headers['retry-after'] = '1';
    return problem({ ...dependencyUnavailable.body, title: 'A required authority service is unavailable' });
  }
}

export function admissionFailure(error: unknown, set: ProblemSet) {
  const authority = authorityFailure(error, set);
  if (authority) return authority;
  if (error instanceof AdmissionConflict) return problem(idempotencyConflict.body);
  if (error instanceof AdmissionControllerContinuity) return problem(controllerContinuity.body);
  if (error instanceof AdmissionLockBusy) {
    set.headers['retry-after'] = '1';
    return problem(admissionBusy.body);
  }
}
