export class RealmInputError extends Error {
  constructor() {
    super('Invalid Realm metadata or revision identity');
    this.name = 'RealmInputError';
  }
}
export class RealmBanInputError extends Error {
  constructor() {
    super('Invalid Realm ban');
    this.name = 'RealmBanInputError';
  }
}
