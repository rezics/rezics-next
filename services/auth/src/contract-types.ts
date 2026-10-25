import type {
  AuthSessionPort,
  AuthCredentialPort,
  AuthRecoveryPort,
  BarrierProofVerifierFactory,
  ProvisioningEvidenceVerifierFactory,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { AuthService } from './index.ts';
import type { createBarrierProofVerifier } from './barrier-proofs.ts';
import type { createProvisioningEvidenceVerifier } from './provisioning-evidence.ts';

type Satisfies<Port, Implementation extends Port> = Implementation;

/** Type-only assertions keep native implementations aligned with kernel ports. */
export type AuthServiceContract = Satisfies<AuthSessionPort & AuthCredentialPort & AuthRecoveryPort, AuthService>;
export type BarrierProofFactoryContract = Satisfies<
  BarrierProofVerifierFactory<Pool>,
  typeof createBarrierProofVerifier
>;
export type ProvisioningEvidenceFactoryContract = Satisfies<
  ProvisioningEvidenceVerifierFactory<Pool>,
  typeof createProvisioningEvidenceVerifier
>;
