export class LibraryConflictError extends Error {
  constructor() {
    super('Library entry revision conflicts');
    this.name = 'LibraryConflictError';
  }
}

export class SourceObservationCapacityError extends LibraryConflictError {
  constructor() {
    super();
    this.message = 'Library source observation limit reached';
    this.name = 'SourceObservationCapacityError';
  }
}

export class EntryAnnotationReviewStoppedError extends Error {
  constructor(readonly reason: 'cancelled' | 'expired') {
    super('Selected annotation review stopped before this item started');
    this.name = 'EntryAnnotationReviewStoppedError';
  }
}
