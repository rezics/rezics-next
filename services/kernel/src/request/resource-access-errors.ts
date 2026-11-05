/** Shared error identities without native command or HTTP initialization dependencies. */
export class ResourceAccessWriteDeniedError extends Error {
  constructor() {
    super('Resource access write denied');
    this.name = 'ResourceAccessWriteDeniedError';
  }
}

export class GrantDeniedError extends ResourceAccessWriteDeniedError {
  constructor() {
    super();
    this.message = 'Access grant administration denied';
    this.name = 'GrantDeniedError';
  }
}

/** Only the authorized, locked native Realm holder predicate may issue this refusal. */
export class RealmLastOwnerError extends GrantDeniedError {
  constructor() {
    super();
    this.name = 'RealmLastOwnerError';
  }
}
