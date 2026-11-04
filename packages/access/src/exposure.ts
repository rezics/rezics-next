import type { Exposure } from './exposure-contract.ts';

export type ExposureDecisionInput = Readonly<{
  exposure: Exposure;
  open: boolean;
  actor: 'anonymous' | 'account';
  clientScope: boolean;
  gateAuthority: boolean;
}>;

export type ExposureDecision = Readonly<{
  allowed: boolean;
  reason: 'public' | 'open' | 'anonymous' | 'scope' | 'gate' | 'gate-authority';
}>;

/** Combine only exposure state, the mounted client scope and a native gate result. */
export function decideExposure(input: ExposureDecisionInput): ExposureDecision {
  if (input.exposure.kind === 'public') return { allowed: true, reason: 'public' };
  if (input.open) return { allowed: true, reason: 'open' };
  if (input.actor !== 'account') return { allowed: false, reason: 'anonymous' };
  if (!input.clientScope) return { allowed: false, reason: 'scope' };
  if (!input.gateAuthority) return { allowed: false, reason: 'gate' };
  return { allowed: true, reason: 'gate-authority' };
}
