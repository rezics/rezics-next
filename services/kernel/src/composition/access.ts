import { createAccessApplication } from '../access/application/index.ts';
import { acknowledgeErasure } from '../access/erasure.ts';
import { bindAccessApplication, tryAccessApplication } from '../access/adapters/bind.ts';
import { createNativeAccessPorts } from '../access/adapters/native.ts';
import type { AccessApplication } from '../access/contract/index.ts';
import { IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION } from '../library/identity-original-work.ts';
import { resolveCollectionKindRawInput } from '../library/collection-kind-input.ts';
import { resolveIdentityAdapterRuntime } from '../semantic/identity-adapter-runtime.ts';

import { createAgentIdentityMaintenance } from '../semantic/adapters/agent-identity-maintenance.ts';

let composed: AccessApplication | undefined;

/** Ordinary createKernel/server/worker composition binds the native Access adapters. */
export function composeAccessApplication(): AccessApplication {
  if (composed && tryAccessApplication() === composed) return composed;
  resolveIdentityAdapterRuntime();
  composed = bindAccessApplication(
    createAccessApplication(
      createNativeAccessPorts(acknowledgeErasure, {
        resolveCollectionKindRawNative: resolveCollectionKindRawInput,
        historyOriginalLibraryDeclaration: () => IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION,
      }),
    ),
    createAgentIdentityMaintenance(),
  );
  return composed;
}

export function composedAccessApplication(): AccessApplication {
  return composed ?? composeAccessApplication();
}
