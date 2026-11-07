/** Subject command/read failures shared without loading editorial command implementations. */
export class SubjectNotFoundError extends Error {}
export class EditorialConflictError extends Error {}

export class SubjectRedirectError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super('Subject has been redirected');
  }
}
