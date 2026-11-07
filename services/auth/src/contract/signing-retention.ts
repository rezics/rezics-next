/** Another controller won the CAS, or every required slot is still occupied. */
export class SigningRotationPending extends Error {
  readonly code = 'signing_rotation_pending';
  constructor() {
    super('Signing rotation pending; refresh generation or wait for retention');
  }
}

/** Signing owns generation CAS, occupied slots and the original key horizon. */
export interface SigningRetentionPort {
  status(): Promise<Readonly<{ generation: number; retiring: string | null }>>;
  prune(input: { expectedGeneration: number }): Promise<unknown>;
}
export interface RetentionMaintenancePorts {
  signing: SigningRetentionPort;
  retainWorkflowHistory(retentionDays: number): Promise<number>;
}
