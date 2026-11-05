/** Installed GET /v1/subjectIdentityOperations/{id} while whole-Kernel declaration emission is pending.
 * Kernel `semantic/http/subjects.ts` remains the wire authority. No runtime client is replaced.
 */
export type SubjectIdentityOperationId = { id: string };
export type SubjectIdentityOperationPending = SubjectIdentityOperationId & { done: false };
export type SubjectIdentityOperationResult = {
  survivor: string;
  redirected: string;
  revision: number;
};
export type SubjectIdentityOperationPublished = SubjectIdentityOperationId & {
  done: true;
  result: SubjectIdentityOperationResult;
};
export type SubjectIdentityOperation = SubjectIdentityOperationPending | SubjectIdentityOperationPublished;
export type SubjectIdentityOperationRead = { operation: SubjectIdentityOperation };
export type SubjectIdentityOperationAdmission = { operation: SubjectIdentityOperationId };

export type SubjectIdentityOperationRoutes = {
  ':id': {
    get: {
      body: unknown;
      params: { id: string };
      query: unknown;
      headers: unknown;
      response: {
        200: SubjectIdentityOperationRead;
        401: unknown;
        404: unknown;
        503: unknown;
      };
    };
  };
};
