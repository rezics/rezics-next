import type { MediaImportFetchConfig } from './media-import.ts';
import type { NativeAuthorErasureWorkflows } from './operation-contract.ts';
import type { TurnstileVerifier } from './turnstile.ts';

/** Trusted server composition only; domain time comes from the kernel clock. */
export type ContentRuntime = Readonly<{
  fetchConfig?: MediaImportFetchConfig;
  workflows?: NativeAuthorErasureWorkflows;
  anonymousVerifier?: TurnstileVerifier;
}>;
