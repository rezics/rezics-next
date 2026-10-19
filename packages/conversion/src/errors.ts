export class ProviderConversionError extends Error {
  constructor(readonly basis: 'record' | 'unsupported') { super(`Provider conversion ${basis}`); }
}
