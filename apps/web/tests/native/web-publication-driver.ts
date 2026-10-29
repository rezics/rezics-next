import { startNativeWebStack } from './stack';
import type { WebPublicationDriver } from '../../../../specs/web-publication-driver';

export async function createWebPublicationDriver(): Promise<WebPublicationDriver> {
  const stack = await startNativeWebStack();
  return {
    async provision() { throw new Error('Publication fixture API setup is not implemented'); },
    request: stack.request,
    async settle() {},
    async proposeCompetingDate() { throw new Error('Not implemented'); },
    async revokeAlice() { throw new Error('Not implemented'); },
    async configurePublicOrigin(origin) { await stack.restartWeb({ publicOrigin: origin }); },
    async interrupt(kind) { throw new Error(`Native interruption unavailable: ${kind}`); },
    async nativeSearch() { throw new Error('Native search fixture is not provisioned'); },
    close: stack.stop,
  };
}
