/** Authentication failure vocabulary shared by request adapters and domain admission. */
export class AuthenticationError extends Error {
  readonly status: 400 | 401;
  readonly challenge: string;

  constructor(status: 400 | 401, challenge: string) {
    super('Authentication failed');
    this.name = 'AuthenticationError';
    this.status = status;
    this.challenge = challenge;
  }
}
