/** Whether a page read may use the reader's session credential. */
export type ReadCredentialMode = 'anonymous' | 'session';

/** The server always starts a public page in the shared anonymous read mode. */
export const anonymousReadMode: ReadCredentialMode = 'anonymous';
