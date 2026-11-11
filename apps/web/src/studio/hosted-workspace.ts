import type { StudioInput, StudioPort, StudioResult } from './contract';
import type { StudioWorkspaceProps } from './workspace';
import type { HostedBookNative, HostedTargetResolver } from './hosted-contract';
import { HostedBookAdapter } from './hosted-adapter';
import { hostedBookNative } from './hosted-actions';
import { hostedFailure } from './hosted-native';

/** These are the shared draft/document lifecycle operations, not a second authoring store. */
export type StudioDocumentPort = Pick<StudioPort,
  'isCurrent' | 'documents' | 'open' | 'createDraft' | 'saveDraft' | 'versions' | 'revision'>;
export type HostedStudioInput = Omit<StudioInput, 'profile' | 'canPublish' | 'publicationUnavailableReason'>;
export type HostedStudioBinding = Readonly<{
  workspace: Pick<StudioWorkspaceProps, 'input' | 'port' | 'bookPort'>;
  /** Exact native create/read/revise/publish operations, independent of the optional shared review UI. */
  book: HostedBookAdapter;
}>;

/** Bind only after a native structure read succeeds. The caller replaces this binding on visit/identity change. */
export async function openHostedStudio(options: {
  catalogueId: string;
  input: HostedStudioInput;
  documents: StudioDocumentPort;
  resolveTarget: HostedTargetResolver;
  isCurrent: () => boolean;
  native?: HostedBookNative;
}, signal: AbortSignal): Promise<StudioResult<HostedStudioBinding>> {
  const { input, documents } = options;
  const current = () => options.isCurrent() && documents.isCurrent();
  const book = new HostedBookAdapter(options.native ?? hostedBookNative, current, options.resolveTarget);
  const loaded = await book.load(options.catalogueId, signal);
  if (!loaded.ok) return loaded;
  if (!current() || signal.aborted) return hostedFailure('denied', 'This Studio visit has ended.');
  async function documentOperation<T>(projectId: string, requestSignal: AbortSignal,
    run: () => Promise<StudioResult<T>>): Promise<StudioResult<T>> {
    if (!current() || requestSignal.aborted || projectId !== input.projectId)
      return hostedFailure('denied', 'This document operation belongs to a different Studio visit.');
    const result = await run();
    return current() && !requestSignal.aborted ? result : hostedFailure('denied', 'This Studio visit has ended.');
  }
  const unsupported = async () => hostedFailure('unavailable', 'This publication action is not available in this workspace.');
  const port: StudioPort = {
    isCurrent: current,
    documents: (request, signal) => documentOperation(request.projectId, signal, () => documents.documents(request, signal)),
    open: (request, signal) => documentOperation(request.projectId, signal, () => documents.open(request, signal)),
    createDraft: (request, signal) => documentOperation(request.projectId, signal, () => documents.createDraft(request, signal)),
    saveDraft: (request, signal) => documentOperation(request.projectId, signal, () => documents.saveDraft(request, signal)),
    versions: (request, signal) => documentOperation(request.projectId, signal, () => documents.versions(request, signal)),
    revision: (request, signal) => documentOperation(request.projectId, signal, () => documents.revision(request, signal)),
    reviewPublication: unsupported,
    publish: unsupported,
    publications: unsupported,
  };
  return { ok: true, value: { book, workspace: {
    input: { ...input, profile: { kind: 'book', structure: loaded.value }, canPublish: false,
      publicationUnavailableReason: 'Publication review and history are not available in this workspace. You can continue saving drafts and organizing chapters.',
    },
    port, bookPort: book,
  } } };
}
