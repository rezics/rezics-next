export class IdentityHistoryWorkUnavailable extends Error {
  constructor() {
    super('identity-history-native-funding-unavailable');
  }
}

export class OperationalWorkUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}

export class HistorySealedError extends Error {
  constructor() {
    super('Account history is sealed');
    this.name = 'HistorySealedError';
  }
}
