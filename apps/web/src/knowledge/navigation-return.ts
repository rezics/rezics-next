import type { KnowledgeNavigationFrontier } from './navigation-model';
import type { KnowledgePrivateAddress } from './private-knowledge';
import type { KnowledgeNavigationFocusReturn, KnowledgeNavigationFocus } from './navigation-focus';

export type KnowledgeNavigationRestoration = KnowledgeNavigationFocusReturn &
  Readonly<{
    frontier?: KnowledgeNavigationFrontier;
    expired: boolean;
  }>;

/** One ephemeral return, with no rows. Nothing is serialized into routes, query caches or storage. */
export class KnowledgeNavigationReturn {
  private pending:
    | {
        binding: string;
        address: KnowledgePrivateAddress;
        frontier: KnowledgeNavigationFrontier;
        placementId?: string;
        expires: number;
      }
    | undefined;
  private intent: { binding: string; notebookId: string; orientation?: KnowledgeNavigationFocus } | undefined;
  constructor(private now = () => Date.now()) {}
  save(binding: string, address: KnowledgePrivateAddress, frontier: KnowledgeNavigationFrontier, placementId?: string) {
    this.clear();
    this.pending = {
      binding,
      address: { ...address },
      frontier: structuredClone(frontier),
      ...(placementId ? { placementId } : {}),
      expires: this.now() + 15 * 60_000,
    };
  }
  returnTo(binding: string, address: KnowledgePrivateAddress, orientation?: KnowledgeNavigationFocus) {
    this.intent?.orientation?.cancel();
    if (
      this.pending?.binding !== binding ||
      this.pending.address.notebookId !== address.notebookId ||
      this.pending.address.documentId !== address.documentId
    )
      this.pending = undefined;
    this.intent = { binding, notebookId: address.notebookId, ...(orientation ? { orientation } : {}) };
  }
  take(binding: string, notebookId: string): KnowledgeNavigationRestoration | undefined {
    const intent = this.intent;
    const pending = this.pending;
    // Transfer the focus request to the mounted reading; clearing the slot later cannot revive it.
    this.pending = undefined;
    this.intent = undefined;
    if (!intent || intent.binding !== binding || intent.notebookId !== notebookId) {
      intent?.orientation?.cancel();
      return;
    }
    const orientation = intent.orientation ? { orientation: intent.orientation } : {};
    if (!pending || pending.binding !== binding || pending.expires <= this.now())
      return { expired: true, ...orientation };
    return {
      frontier: pending.frontier,
      documentId: pending.address.documentId,
      ...(pending.placementId ? { placementId: pending.placementId } : {}),
      expired: false,
      ...orientation,
    };
  }
  retireForAddress(binding: string, address: KnowledgePrivateAddress) {
    if (
      this.pending &&
      (this.pending.binding !== binding ||
        this.pending.address.notebookId !== address.notebookId ||
        this.pending.address.documentId !== address.documentId)
    )
      this.clear();
  }
  leave(pathname: string) {
    const path = pathname.replace(/\/$/, '');
    if (this.pending) {
      const { notebookId, documentId } = this.pending.address;
      if (path.endsWith(`/knowledge/notebooks/${notebookId}/documents/${documentId}`)) return;
    }
    if (this.intent && path.endsWith(`/knowledge/notebooks/${this.intent.notebookId}`)) return;
    this.clear();
  }
  retireUnless(binding: string) {
    if ((this.pending && this.pending.binding !== binding) || (this.intent && this.intent.binding !== binding))
      this.clear();
  }
  clear() {
    this.intent?.orientation?.cancel();
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
