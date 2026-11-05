export type SubjectPageReadLifetime = AbortSignal;

export function assertSubjectPageReadActive(lifetime?: SubjectPageReadLifetime): void {
  lifetime?.throwIfAborted();
}
