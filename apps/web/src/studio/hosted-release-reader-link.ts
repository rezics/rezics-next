import type { PublicationRecord } from './contract';
import type { HostedOwnerBook } from './hosted-contract';

export type HostedReleaseReaderAddress = Readonly<{ catalogueId: string; releaseRevisionId: string }>;
/** Anonymous catalogue metadata admission, separate from the author's owner-only observation. */
export type HostedReleaseReaderAdmission = (
  address: HostedReleaseReaderAddress,
  signal: AbortSignal,
) => Promise<boolean>;

export type HostedReleaseReaderBinding = Readonly<{
  subscribe: (listener: () => void) => () => void;
  snapshot: () => HostedReleaseReaderAddress | null;
}>;

/** One author visit's projection. It owns no drafts, selection, bodies or publication commands. */
export class HostedReleaseReaderLinkProjection implements HostedReleaseReaderBinding {
  private address: HostedReleaseReaderAddress | null = null;
  private retired = false;
  private confirmation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly catalogueId: string,
    private readonly isCurrent: () => boolean,
    private readonly admit: HostedReleaseReaderAdmission,
  ) {}

  private current(): boolean {
    // A replaced visit cannot regain its link, even if the same account signs in again.
    this.retired ||= !this.isCurrent();
    return !this.retired;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): HostedReleaseReaderAddress | null => (this.current() ? this.address : null);

  clear = (): void => {
    this.confirmation += 1;
    this.address = null;
    this.listeners.forEach((listener) => listener());
  };

  /** A confirmed exact metadata/window observation proves nonempty without inventing a full manifest. */
  confirmBounded = async (
    owner: HostedOwnerBook,
    evidence: Readonly<{ catalogueId: string; revisionId: string; nonempty: boolean }>,
    signal: AbortSignal,
  ): Promise<void> => {
    this.clear();
    if (
      !this.current() ||
      signal.aborted ||
      owner.catalogueId !== this.catalogueId ||
      evidence.catalogueId !== this.catalogueId ||
      owner.postVisibility !== 'published' ||
      !evidence.nonempty ||
      owner.publicationId !== evidence.revisionId
    )
      return;
    const address = { catalogueId: this.catalogueId, releaseRevisionId: evidence.revisionId };
    const confirmation = this.confirmation;
    const admitted = await this.admit(address, signal);
    if (!this.current() || signal.aborted || !admitted || confirmation !== this.confirmation) return;
    this.address = address;
    this.listeners.forEach((listener) => listener());
  };

  /** Called only with the current/reconfirmed owner pointer and its exact, admitted manifest. */
  confirm = async (
    owner: HostedOwnerBook,
    publication: PublicationRecord | null,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!publication || publication.state !== 'published') {
      this.clear();
      return;
    }
    await this.confirmBounded(
      owner,
      {
        catalogueId: this.catalogueId,
        revisionId: publication.revision,
        nonempty: publication.entries.length > 0,
      },
      signal,
    );
  };
}
