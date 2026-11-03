export class LibraryConflictError extends Error {
  constructor() {
    super('Library entry revision conflicts');
    this.name = 'LibraryConflictError';
  }
}

export class EntryAnnotationReviewStoppedError extends Error {
  constructor(readonly reason: 'cancelled' | 'expired') {
    super('Selected annotation review stopped before this item started');
    this.name = 'EntryAnnotationReviewStoppedError';
  }
}
