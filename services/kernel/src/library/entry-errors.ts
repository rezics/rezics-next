export class LibraryConflictError extends Error {
  constructor() {
    super('Library entry revision conflicts');
    this.name = 'LibraryConflictError';
  }
}
