/** Shared error identities without native command or HTTP initialization dependencies. */
export class ResourceAccessWriteDeniedError extends Error {
  constructor() {
    super('Resource access write denied');
    this.name = 'ResourceAccessWriteDeniedError';
  }
}

/** Only the authorized, locked native Realm holder predicate may issue this refusal. */
export class RealmLastOwnerError extends ResourceAccessWriteDeniedError {
  constructor() {
    super();
    this.name = 'RealmLastOwnerError';
  }
}
