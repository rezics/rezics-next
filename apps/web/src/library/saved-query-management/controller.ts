import type { CollectionWriteResult } from '../collection-edit';
import {
  captureCollectionDelete,
  captureCollectionUpdate,
  type CapturedCollectionCommand,
} from '../collection-commands';
import { admitsCollectionOperation } from '../collection-records';
import { collectionTextIssue } from '../collection-text-input';
import type { DynamicCollectionPage } from '../dynamic-collection';

export type ManagedSavedQuery = Pick<
  DynamicCollectionPage,
  'id' | 'title' | 'description' | 'revision' | 'curatorAccountId' | 'builtinKind' | 'visibility' | 'viewerActions'
>;
export type ManagementOperation = 'collection.update' | 'collection.delete';
export type ManagementDialog = 'delete' | 'departure' | 'reconcile';
export type ManagementOutcome = 'saved' | 'unknown' | 'conflict' | 'refused';

export type SavedQueryManagementState = {
  phase: 'closed' | 'reading' | 'ready' | 'unavailable' | 'denied';
  snapshot: ManagedSavedQuery | null;
  title: string;
  description: string;
  textSubmitted: boolean;
  busy: boolean;
  intent: SavedQueryIntent | null;
  outcome: ManagementOutcome | null;
  dialog: ManagementDialog | null;
  confirmedNotice: 'saved' | null;
};

type UpdateCommand = CapturedCollectionCommand<Parameters<typeof captureCollectionUpdate>[0]>;
type DeleteCommand = CapturedCollectionCommand<Parameters<typeof captureCollectionDelete>[0]>;
type SavedQueryIntent =
  | { operation: 'collection.update'; command: UpdateCommand }
  | { operation: 'collection.delete'; command: DeleteCommand };

type ControllerPorts = {
  collectionId: string;
  viewerId: string;
  readCurrent: () => Promise<ManagedSavedQuery>;
  isCurrent: (operation: ManagementOperation, page: ManagedSavedQuery) => boolean;
  csrf: (operation: ManagementOperation) => string | null;
  onMetadata: (page: ManagedSavedQuery) => void;
  onDeleted: () => void;
  update?: typeof captureCollectionUpdate;
  remove?: typeof captureCollectionDelete;
};

const emptyState = (): SavedQueryManagementState => ({
  phase: 'closed',
  snapshot: null,
  title: '',
  description: '',
  textSubmitted: false,
  busy: false,
  intent: null,
  outcome: null,
  dialog: null,
  confirmedNotice: null,
});

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function ordinaryOwnerPage(page: ManagedSavedQuery, id: string, viewerId: string): boolean {
  return (
    page.id === id &&
    !page.builtinKind &&
    page.curatorAccountId === viewerId &&
    page.visibility !== undefined &&
    page.visibility !== null &&
    isRevision(page.revision)
  );
}

function actionFor(operation: ManagementOperation) {
  return operation === 'collection.update' ? 'collection:update' : 'collection:delete';
}

function nativeAllows(page: ManagedSavedQuery, operation: ManagementOperation): boolean {
  return admitsCollectionOperation(page.viewerActions, actionFor(operation), operation);
}

/**
 * One mounted manager owns its private draft and uncertain command. Its caller retires it when the
 * viewer, Collection, reader result or CSRF session changes.
 */
export class SavedQueryManagementController {
  private state: SavedQueryManagementState = emptyState();
  private listeners = new Set<() => void>();
  private retired = false;
  private readonly update: typeof captureCollectionUpdate;
  private readonly remove: typeof captureCollectionDelete;

  constructor(private readonly ports: ControllerPorts) {
    this.update = ports.update ?? captureCollectionUpdate;
    this.remove = ports.remove ?? captureCollectionDelete;
  }

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(next: SavedQueryManagementState) {
    if (this.retired) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<SavedQueryManagementState>) {
    this.publish({ ...this.state, ...patch });
  }

  can(operation: ManagementOperation): boolean {
    const page = this.state.snapshot;
    return Boolean(
      page &&
      ordinaryOwnerPage(page, this.ports.collectionId, this.ports.viewerId) &&
      nativeAllows(page, operation) &&
      this.ports.isCurrent(operation, page),
    );
  }

  async open() {
    if (this.retired || this.state.busy || this.state.phase === 'reading') return;
    await this.readAndReplace();
  }

  private async readAndReplace(confirmedNotice: 'saved' | null = null) {
    if (this.retired) return;
    this.publish({ ...emptyState(), phase: 'reading' });
    let page: ManagedSavedQuery;
    try {
      page = await this.ports.readCurrent();
    } catch {
      if (!this.retired) this.publish({ ...emptyState(), phase: 'unavailable', confirmedNotice });
      return;
    }
    if (this.retired) return;
    if (!ordinaryOwnerPage(page, this.ports.collectionId, this.ports.viewerId)) {
      this.publish({ ...emptyState(), phase: 'denied', confirmedNotice });
      return;
    }
    if (!page.viewerActions || page.viewerActions.state === 'unavailable') {
      this.publish({ ...emptyState(), phase: 'unavailable', confirmedNotice });
      return;
    }
    const hasAnOwnerCommand = nativeAllows(page, 'collection.update') || nativeAllows(page, 'collection.delete');
    if (!hasAnOwnerCommand) {
      this.publish({ ...emptyState(), phase: 'denied', confirmedNotice });
      return;
    }
    this.ports.onMetadata(page);
    this.publish({
      ...emptyState(),
      phase: 'ready',
      snapshot: page,
      title: page.title,
      description: page.description ?? '',
      confirmedNotice,
    });
  }

  async retryRead() {
    if (this.state.phase === 'reading' || this.state.busy) return;
    if (this.state.intent && this.state.outcome === 'unknown') {
      this.requestReconcile();
      return;
    }
    await this.readAndReplace(this.state.confirmedNotice);
  }

  setTitle(title: string) {
    if (this.state.phase === 'ready' && !this.state.busy && !this.state.intent && this.can('collection.update'))
      this.patch({ title });
  }

  setDescription(description: string) {
    if (this.state.phase === 'ready' && !this.state.busy && !this.state.intent && this.can('collection.update'))
      this.patch({ description });
  }

  get dirty(): boolean {
    const snapshot = this.state.snapshot;
    return Boolean(
      snapshot && (this.state.title !== snapshot.title || this.state.description !== (snapshot.description ?? '')),
    );
  }

  async save() {
    const snapshot = this.state.snapshot;
    if (this.state.intent?.operation === 'collection.update' && this.state.outcome === 'unknown') {
      this.retryOriginal();
      return;
    }
    if (this.state.phase !== 'ready' || !snapshot || this.state.busy || !this.can('collection.update')) return;
    if (collectionTextIssue('title', this.state.title) || collectionTextIssue('description', this.state.description)) {
      this.patch({ textSubmitted: true });
      return;
    }
    if (!this.dirty) return;
    const csrfToken = this.ports.csrf('collection.update');
    if (!csrfToken) {
      this.patch({ outcome: 'refused' });
      return;
    }
    const command = this.update(
      {
        collectionId: snapshot.id,
        revision: snapshot.revision!,
        title: this.state.title,
        description: this.state.description,
        visibility: snapshot.visibility!,
        idempotencyKey: crypto.randomUUID(),
      },
      csrfToken,
    );
    await this.dispatch({ operation: 'collection.update', command });
  }

  requestDelete() {
    if (this.state.phase === 'ready' && !this.state.busy && this.can('collection.delete'))
      this.patch({ dialog: 'delete' });
  }

  cancelDialog() {
    if (this.state.busy) return;
    this.patch({ dialog: null });
  }

  async confirmDelete() {
    const snapshot = this.state.snapshot;
    if (
      this.state.phase !== 'ready' ||
      !snapshot ||
      this.state.dialog !== 'delete' ||
      this.state.busy ||
      !this.can('collection.delete')
    )
      return;
    const csrfToken = this.ports.csrf('collection.delete');
    if (!csrfToken) {
      this.patch({ dialog: null, outcome: 'refused' });
      return;
    }
    const command = this.remove(
      {
        collectionId: snapshot.id,
        revision: snapshot.revision!,
        idempotencyKey: crypto.randomUUID(),
      },
      csrfToken,
    );
    this.patch({ dialog: null });
    await this.dispatch({ operation: 'collection.delete', command });
  }

  async retryOriginal() {
    const intent = this.state.intent;
    const snapshot = this.state.snapshot;
    if (!intent || !snapshot || this.state.busy || this.state.outcome !== 'unknown' || !this.can(intent.operation))
      return;
    await this.dispatch(intent);
  }

  private async dispatch(intent: SavedQueryIntent) {
    const snapshot = this.state.snapshot;
    if (!snapshot || this.state.busy || !this.can(intent.operation)) return;
    this.patch({ busy: true, outcome: null, intent });
    let result: CollectionWriteResult;
    try {
      result = await intent.command.send();
    } catch {
      if (!this.retired) this.patch({ busy: false, outcome: 'unknown', intent });
      return;
    }
    if (this.retired) return;
    if (!this.can(intent.operation)) {
      this.patch({ busy: false, outcome: 'unknown', intent });
      return;
    }
    if (!result.ok) {
      this.patch({
        busy: false,
        intent: result.reason === 'unavailable' ? intent : null,
        outcome: result.reason === 'unavailable' ? 'unknown' : result.reason === 'conflict' ? 'conflict' : 'refused',
      });
      return;
    }
    if (intent.operation === 'collection.delete') {
      this.publish(emptyState());
      this.ports.onDeleted();
      return;
    }
    if (!isRevision(result.revision)) {
      // The installed update command normally returns the new CAS revision. If it does not,
      // retire the old command authority and replace the private metadata with a fresh read.
      void this.readAndReplace('saved');
      return;
    }
    const updated: ManagedSavedQuery = {
      ...snapshot,
      title: this.state.title,
      description: this.state.description || null,
      revision: result.revision,
    };
    this.ports.onMetadata(updated);
    this.publish({
      ...this.state,
      phase: 'ready',
      snapshot: updated,
      title: updated.title,
      description: updated.description ?? '',
      textSubmitted: false,
      busy: false,
      intent: null,
      outcome: 'saved',
      dialog: null,
    });
  }

  requestClose() {
    if (this.state.phase !== 'ready' || this.state.busy) return;
    if (this.state.intent && this.state.outcome === 'unknown') {
      this.patch({ dialog: 'reconcile' });
      return;
    }
    if (this.dirty) {
      this.patch({ dialog: 'departure' });
      return;
    }
    this.publish(emptyState());
  }

  confirmDeparture() {
    if (this.state.busy || this.state.dialog !== 'departure') return;
    this.publish(emptyState());
  }

  requestReconcile() {
    if (this.state.phase === 'ready' && !this.state.busy) this.patch({ dialog: 'reconcile' });
  }

  async confirmReconcile() {
    if (this.state.busy || this.state.dialog !== 'reconcile') return;
    // Reading current metadata deliberately retires the unknown command's exact retry authority.
    await this.readAndReplace();
  }

  retire() {
    this.retired = true;
    this.state = emptyState();
    this.listeners.clear();
  }
}
