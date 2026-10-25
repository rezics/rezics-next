import type { AuthService } from '@rezics/auth';
import type { ContentActors, ContentSystem, ContentSystemOptions } from './system.ts';

export type NativeContentSystem = Omit<ContentSystem, 'actors' | 'auth'> & {
  readonly actors: Omit<ContentActors, 'worker' | 'otherWorker'>;
  readonly auth: Omit<ContentSystem['auth'], 'websiteClient'>;
  /** The full fixture registers its website client on this same real Auth service. */
  readonly nativeAuth: AuthService;
};

export class NativeContentSystemUnfinishedError extends Error {
  constructor() {
    super('Native content system is unfinished; actual native composition is required');
    this.name = 'NativeContentSystemUnfinishedError';
  }
}

/** Ordinary identity fixture contract only; no runtime behavior is implemented here.
 * The implementation must use actual operator bootstrap, native lifecycle/Auth,
 * /token and JWKS verification, and public permission commands. Approval Maps,
 * grant SQL and JWT resigning cannot substitute for those paths.
 * The full website fixture must extend this service with real client registration
 * and genuine website issuance, including exclusive media:complete authority.
 * This zero-I/O stub touches no partitions, rows or indexes for any subject,
 * activity or media volume. Actual native paths and final persona outcomes still
 * require implementation evidence through the shared harness.
 */
export function createNativeContentSystem(_options: ContentSystemOptions): Promise<NativeContentSystem> {
  throw new NativeContentSystemUnfinishedError();
}
