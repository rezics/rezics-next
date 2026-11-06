/** Application and adapter share this refusal; the adapter maps it to GrantDeniedError. */
export class RealmClaimDeniedError extends Error {
  constructor() {
    super('Realm claim denied');
    this.name = 'RealmClaimDeniedError';
  }
}
