import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
export type TerminalClosureLocator = Readonly<{
  original: string; route: number; terminal: string; home: number; generation: string; incarnation: string;
  enrollment: string; revision: string; ownerEpoch: number; immediate: string;
}>;
export type TerminalEnrollment = Readonly<{
  source: TerminalClosureLocator; export: IdentityNativeReceipt; registration: IdentityNativeReceipt;
}>;
export type TerminalDrain = Readonly<{
  home: number; terminal: string; generation: string; incarnation: string; claim: string;
  native: IdentityNativeReceipt; state: 'more' | 'drained';
}>;
