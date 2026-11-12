import type { KnowledgeNavigationFrontier } from './navigation-model';
import type { KnowledgePrivateAddress } from './private-knowledge';

/** One ephemeral return, with no rows. Nothing is serialized into routes, query caches or storage. */
export class KnowledgeNavigationReturn {
  private pending:
    | { binding: string; address: KnowledgePrivateAddress; frontier: KnowledgeNavigationFrontier; expires: number }
    | undefined;
  private intent: { binding: string; notebookId: string } | undefined;
  constructor(private now = () => Date.now()) {}
  save(binding: string, address: KnowledgePrivateAddress, frontier: KnowledgeNavigationFrontier) {
    this.pending = {
      binding,
      address: { ...address },
      frontier: structuredClone(frontier),
      expires: this.now() + 15 * 60_000,
    };
    this.intent = undefined;
  }
  returnTo(binding: string, address: KnowledgePrivateAddress) {
    if (
      this.pending?.binding !== binding ||
      this.pending.address.notebookId !== address.notebookId ||
      this.pending.address.documentId !== address.documentId
    )
      this.pending = undefined;
    this.intent = { binding, notebookId: address.notebookId };
  }
  take(binding: string, notebookId: string): { frontier?: KnowledgeNavigationFrontier; expired: boolean } | undefined {
    const intent = this.intent;
    const pending = this.pending;
    this.clear();
    if (!intent || intent.binding !== binding || intent.notebookId !== notebookId) return;
    if (!pending || pending.binding !== binding || pending.expires <= this.now()) return { expired: true };
    return { frontier: pending.frontier, expired: false };
  }
  retireUnless(binding: string) {
    if (this.pending && this.pending.binding !== binding) this.clear();
  }
  clear() {
    this.pending = undefined;
    this.intent = undefined;
  }
}

export function knowledgeNavigationBinding(
  viewer: string,
  csrfToken: string,
  sessionRevision: number,
  exposureRevision: string,
  locale: string,
) {
  return JSON.stringify([viewer, csrfToken, sessionRevision, exposureRevision, locale]);
}
