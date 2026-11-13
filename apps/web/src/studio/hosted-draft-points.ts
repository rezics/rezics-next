import type { StudioResult, StudioRevision, StudioSelection } from './contract';
import type {
  HostedDraftPointNative,
  HostedDraftPointRequest,
  HostedOutlineWindowPage,
  HostedTarget,
} from './hosted-contract';
import {
  HostedDraftCommandVisit,
  type DraftCommandOptions,
  type DraftCommandTransport,
  type HostedDraftCommandState,
} from './hosted-draft-point-lifecycle';
import { hostedOccurrenceId } from './hosted-structure';

type AvailableOccurrence = Extract<HostedOutlineWindowPage['items'][number], { availability: 'available' }>;
export type DraftPointAnchor = Readonly<{ revisionId: string; item: AvailableOccurrence }>;
export type DraftPointChoices = Readonly<{
  kind: 'part' | 'chapter' | 'remove' | 'update';
  update: DraftPointAnchor | null;
  parent: DraftPointAnchor | null;
  before: DraftPointAnchor | null;
  removal: DraftPointAnchor | null;
  versionHead: string | null;
}>;
export type HostedDraftPointState = HostedDraftCommandState<HostedDraftPointRequest, DraftPointChoices>;
export type DraftPointTransport = DraftCommandTransport & HostedDraftPointNative;
type Options = Omit<
  DraftCommandOptions<HostedDraftPointRequest, DraftPointChoices>,
  'choice' | 'prepare' | 'send' | 'refreshed' | 'selected' | 'native'
> & {
  native: DraftPointTransport;
  readTarget?(target: HostedTarget, signal: AbortSignal): Promise<StudioResult<StudioRevision>>;
  readVersion(selection: StudioSelection, signal: AbortSignal): Promise<StudioResult<StudioRevision>>;
};

export function draftPointReady(state: Extract<HostedDraftPointState, { kind: 'active' }>): boolean {
  const { choice, head } = state;
  if (choice.kind === 'remove') return choice.removal?.revisionId === head;
  if (choice.kind === 'update') {
    const item = choice.update?.item;
    if (!item || choice.update?.revisionId !== head || !state.title.trim() || [...state.title.trim()].length > 256)
      return false;
    if (item.kind === 'part') return true;
    return (
      choice.versionHead === head &&
      state.selection?.revision.exact.postId === item.target.postId &&
      (state.selection.native?.threadId === item.target.threadId ||
        (state.selection.revision.exact.revisionId === item.target.revisionId &&
          state.selection.revision.exact.sha256 === item.target.sha256))
    );
  }
  if (!state.title.trim() || [...state.title.trim()].length > 256) return false;
  if (choice.parent && choice.parent.revisionId !== head) return false;
  if (choice.before && choice.before.revisionId !== head) return false;
  if (choice.kind === 'chapter') return state.selection !== null && choice.versionHead === head;
  return true;
}

/** A few reviewed occurrences, never a cache of pages or a replacement outline. */
export class HostedDraftPointVisit extends HostedDraftCommandVisit<HostedDraftPointRequest, DraftPointChoices> {
  constructor(private readonly pointOptions: Options) {
    super({
      ...pointOptions,
      choice: { kind: 'part', update: null, parent: null, before: null, removal: null, versionHead: null },
      selected: (choice, _selection, head) => ({ ...choice, versionHead: head }),
      refreshed: (choice) => ({
        ...choice,
        versionHead: null,
        parent: choice.parent && { ...choice.parent, revisionId: '' },
        before: choice.before && { ...choice.before, revisionId: '' },
        removal: choice.removal && { ...choice.removal, revisionId: '' },
        update: choice.update && { ...choice.update, revisionId: '' },
      }),
      async prepare(state, key) {
        if (!draftPointReady(state)) return null;
        const envelope = {
          catalogueId: pointOptions.owner.item.catalogueId,
          expectedViewer: { ...pointOptions.owner.viewer },
          idempotencyKey: key,
        };
        const { choice } = state;
        if (choice.kind === 'remove')
          return {
            ...envelope,
            kind: 'remove',
            body: { expectedRevisionId: state.head, occurrenceId: choice.removal!.item.occurrenceId },
          };
        if (choice.kind === 'update')
          return {
            ...envelope,
            kind: 'update',
            body: {
              expectedRevisionId: state.head,
              occurrenceId: choice.update!.item.occurrenceId,
              title: state.title.trim(),
              target:
                choice.update!.item.kind === 'part'
                  ? null
                  : {
                      threadId: choice.update!.item.target.threadId,
                      ...state.selection!.revision.exact,
                    },
            },
          };
        return {
          ...envelope,
          kind: 'insert',
          body: {
            expectedRevisionId: state.head,
            occurrenceId: await hostedOccurrenceId(envelope.catalogueId, key),
            parentId: choice.parent?.item.occurrenceId ?? null,
            beforeOccurrenceId: choice.before?.item.occurrenceId ?? null,
            title: state.title.trim(),
            placement:
              choice.kind === 'part'
                ? { kind: 'part' }
                : { kind: 'chapter', target: { ...pointOptions.picker.target(state.selection!.revision.exact)! } },
          },
        };
      },
      send: (request, signal, csrf) => pointOptions.native.writeDraftPoint(request, signal, csrf),
    });
  }

  private choose(change: (choice: DraftPointChoices) => DraftPointChoices) {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    this.update({ ...this.state, choice: change(this.state.choice), phase: 'idle', intent: null, error: null });
  }
  setKind = (kind: DraftPointChoices['kind']) => this.choose((choice) => ({ ...choice, kind }));
  root = () => this.choose((choice) => ({ ...choice, parent: null, before: null }));
  end = () => this.choose((choice) => ({ ...choice, before: null }));

  /** Only a row in the currently displayed exact page can become a new reviewed anchor. */
  observe = (occurrenceId: string, role: 'parent' | 'before' | 'removal' | 'update') => {
    if (this.state.kind !== 'active') return;
    const page = this.state.outline.snapshot();
    if (page.kind !== 'ready') return;
    const item = page.page.items.find((row) => row.occurrenceId === occurrenceId);
    if (!item || item.availability !== 'available') return;
    const anchor: DraftPointAnchor = { revisionId: this.state.head, item: { ...item } };
    this.choose((choice) => {
      if (role === 'update') return { ...choice, update: anchor, kind: 'update', versionHead: null };
      if (role === 'parent') return item.kind === 'part' ? { ...choice, parent: anchor, before: null } : choice;
      if (role === 'before')
        return item.parentId === (choice.parent?.item.occurrenceId ?? null) ? { ...choice, before: anchor } : choice;
      return { ...choice, removal: anchor, kind: 'remove' };
    });
    if (role === 'update' && this.state.kind === 'active' && this.canEdit()) this.setTitle(item.title);
  };

  admitsPost = (postId: string) =>
    this.isCurrent() &&
    this.state.kind === 'active' &&
    this.state.choice.update?.item.kind === 'chapter' &&
    this.state.choice.update.item.target.postId === postId;

  readUpdateVersion = async () => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active') return;
    const state = this.state;
    const item = state.choice.update?.item;
    if (item?.kind !== 'chapter' || !this.pointOptions.readTarget) return;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'preparing', intent: null, error: null });
    try {
      const result = await this.pointOptions.readTarget(item.target, request.signal);
      if (!this.current(request)) return;
      this.update(
        result.ok
          ? {
              ...state,
              phase: 'idle',
              selection: {
                revision: result.value,
                permissions: { edit: true, publish: false },
              },
              choice: { ...state.choice, versionHead: state.head },
              error: null,
            }
          : { ...state, phase: 'rejected', error: result.error },
      );
    } finally {
      if (this.request === request) this.request = null;
    }
  };

  /** Reread the original exact revision through the Post owner; never reopen its latest head. */
  rereadVersion = async () => {
    if (!this.current() || !this.canEdit() || this.state.kind !== 'active' || !this.state.selection) return;
    const state = this.state;
    const request = new AbortController();
    this.request = request;
    this.update({ ...state, phase: 'preparing', intent: null, error: null });
    try {
      const result = await this.pointOptions.readVersion(state.selection!, request.signal);
      if (!this.current(request)) return;
      this.update(
        result.ok
          ? {
              ...state,
              selection: { ...state.selection!, revision: result.value },
              choice: { ...state.choice, versionHead: state.head },
              phase: 'idle',
              intent: null,
              error: null,
            }
          : { ...state, phase: 'rejected', intent: null, error: result.error },
      );
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
