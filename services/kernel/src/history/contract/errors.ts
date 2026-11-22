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

/** The original JSON response is too large to retain as one native receipt. */
export class HistoryReceiptTooLargeError extends TypeError {
  constructor() {
    super('History payload exceeds the 64 KiB limit');
    this.name = 'HistoryReceiptTooLargeError';
  }
}
