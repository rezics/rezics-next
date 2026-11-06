import { platformRegistry, validateZoneConfiguration, type CompositionViolation } from '@rezics/composition';
import type {
  ZoneConfigurationResponse,
  ZoneConfigureInput,
  ZoneOwned,
  ZonePageResponse,
  ZonePublishInput,
} from '../../../zones/appearance';
import { hasValidOwnerCsrfToken, type OwnerReadObservation } from './owner-lifetime';

export type { ZoneConfigurationResponse, ZoneConfigureInput, ZoneOwned, ZonePageResponse };
export type Visibility = ZonePublishInput['visibility'];
export type Failure = {
  kind: 'failure';
  status: number;
  code: string;
  errors?: { pointer: string; code: string }[];
  retryAfter?: string;
  ownerObservation?: OwnerReadObservation;
};
export type Result<T> = { kind: 'ready'; value: T; ownerObservation?: OwnerReadObservation } | Failure;
export type Permissions = { configure: boolean; publish: boolean; available: boolean; failure?: Failure };
export type Options = {
  scopes: Result<{ release: string; ids: string[] }>;
  collections: Result<{ items: { id: string; title: string }[]; next: string | null }>;
};
export type Loaded = {
  resource: Result<ZoneConfigurationResponse>;
  permissions: Permissions;
  options: Options;
  ownerObservation?: OwnerReadObservation;
};
export type Mutation = {
  id: string;
  revision: string;
  key: string;
} & ({ operation: 'save'; body: ZoneConfigureInput } | { operation: 'publish'; body: ZonePublishInput });
export type LifecycleReading = Pick<ZoneOwned, 'revision' | 'deletedAt' | 'restoreUntil'>;
export type LifecycleMutation = {
  id: string;
  revision: string;
  key: string;
  csrf: string;
  operation: 'delete' | 'restore';
};
export type Preview =
  | Result<ZonePageResponse>
  | { kind: 'preparing'; retryAfter: string; ownerObservation?: OwnerReadObservation };
export type Transport = {
  load(): Promise<Loaded>;
  mutate(input: Mutation): Promise<Result<ZoneOwned>>;
  lifecycle(input: LifecycleMutation): Promise<Result<LifecycleReading>>;
  preview(route: string): Promise<Preview>;
  collections(cursor: string): Promise<Options['collections']>;
};

export const unavailable: Failure = { kind: 'failure', status: 503, code: 'dependency_unavailable' };
export const validRevision = (value: string) => /^[1-9][0-9]*$/.test(value);

/** Navigation is derived from sorted configured routes; it has no second editable store. */
export function configurationErrors(draft: ZoneConfigureInput, filters: ReadonlySet<string>): CompositionViolation[] {
  const errors = validateZoneConfiguration(platformRegistry, draft.configuration, { filters });
  draft.configuration.pages.forEach((page, index) => {
    if (page.route.split('/')[0] === 'subjects') errors.push({ pointer: `/pages/${index}/route`, code: 'invalid' });
  });
  if (draft.mounts.length > 16 || new Set(draft.mounts).size !== draft.mounts.length)
    errors.push({ pointer: '/mounts', code: 'limit' });
  return errors;
}

export function readerHref(id: string, route: string, locale: string): string {
  return `/${encodeURIComponent(locale)}/zones/${encodeURIComponent(id)}${route ? `/${route.split('/').map(encodeURIComponent).join('/')}` : ''}`;
}

export type EditorState = {
  loaded: Loaded;
  saved?: ZoneConfigurationResponse | undefined;
  draft?: ZoneConfigureInput | undefined;
  busy: boolean;
  failure?: Failure | undefined;
  violations: CompositionViolation[];
  conflict?: Loaded | undefined;
  preview?: Preview | undefined;
  notice?: 'saved' | 'published' | undefined;
  generation: number;
};

/** One mounted editor owns its private draft, CAS basis and immutable retry request. */
export class ZoneEditorSession {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private attempt: { signature: string; input: Mutation | LifecycleMutation } | undefined;
  private readonly ownerCurrent: () => boolean;
  private readonly ownerObservation: OwnerReadObservation | undefined;
  private readonly ownerCanWrite: () => boolean;
  private readonly ownerCsrf: () => string;
  private readonly retireOwner: (() => void) | undefined;
  constructor(
    private readonly transport: Transport,
    loaded: Loaded,
    private key = () => crypto.randomUUID(),
    owner?: {
      isCurrent(): boolean;
      observation: OwnerReadObservation;
      retire(): void;
      canWrite?(): boolean;
      csrf?(): string | null;
    },
  ) {
    this.ownerCurrent = owner ? owner.isCurrent : () => true;
    this.ownerObservation = owner?.observation;
    this.ownerCanWrite = owner?.canWrite ?? (() => true);
    this.ownerCsrf = () => owner?.csrf?.() ?? '';
    this.retireOwner = owner?.retire;
    const saved = loaded.resource.kind === 'ready' ? loaded.resource.value : undefined;
    this.state = {
      loaded,
      ...(saved ? { saved, draft: structuredClone({ configuration: saved.configuration, mounts: saved.mounts }) } : {}),
      busy: false,
      violations: [],
      generation: 0,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  isCurrent() {
    return this.current();
  }
  clearPreview() {
    if (!this.current()) return;
    this.update({ preview: undefined });
  }
  private update(patch: Partial<EditorState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private current() {
    return this.ownerCurrent();
  }
  private localFailure(): Failure {
    return unavailable;
  }
  private matchesOwner(response: { ownerObservation?: OwnerReadObservation }): boolean {
    if (!this.ownerObservation) return true;
    const observation = response.ownerObservation;
    const matches =
      !!observation &&
      observation.reader === this.ownerObservation.reader &&
      observation.admission === this.ownerObservation.admission;
    if (!matches) this.retireOwner?.();
    return matches;
  }
  dirty() {
    if (!this.current()) return false;
    const { saved, draft } = this.state;
    return (
      !!draft &&
      !!saved &&
      JSON.stringify(draft) !== JSON.stringify({ configuration: saved.configuration, mounts: saved.mounts })
    );
  }
  edit(draft: ZoneConfigureInput) {
    if (!this.current() || this.state.busy || this.state.conflict || !this.state.loaded.permissions.configure) return;
    this.update({
      draft: structuredClone(draft),
      failure: undefined,
      violations: [],
      preview: undefined,
      notice: undefined,
    });
  }
  async refresh() {
    if (!this.current() || this.state.busy) return;
    this.update({ busy: true });
    try {
      if (!this.current()) return;
      const loaded = await this.transport.load();
      if (!this.current() || !this.matchesOwner(loaded)) return;
      if (this.state.draft) {
        this.update({ conflict: loaded, busy: false });
      } else this.accept(loaded);
    } catch {
      if (!this.current()) return;
      this.update({ busy: false, failure: this.localFailure() });
    }
  }
  private accept(loaded: Loaded) {
    if (!this.current() || !this.matchesOwner(loaded)) return;
    const saved = loaded.resource.kind === 'ready' ? loaded.resource.value : undefined;
    this.attempt = undefined;
    this.update({
      loaded,
      saved,
      draft: saved ? structuredClone({ configuration: saved.configuration, mounts: saved.mounts }) : undefined,
      conflict: undefined,
      failure: undefined,
      violations: [],
      preview: undefined,
      notice: undefined,
      busy: false,
      generation: this.state.generation + 1,
    });
  }
  resolve(choice: 'reload' | 'reapply') {
    if (!this.current()) return;
    const loaded = this.state.conflict;
    if (!loaded || loaded.resource.kind !== 'ready') return;
    if (choice === 'reload') this.accept(loaded);
    else {
      this.attempt = undefined;
      this.update({
        loaded,
        saved: loaded.resource.value,
        conflict: undefined,
        failure: undefined,
        violations: [],
        preview: undefined,
      });
    }
  }
  async save() {
    await this.write('save');
  }
  async publish(visibility: Visibility) {
    await this.write('publish', visibility);
  }
  async changeLifecycle(operation: 'delete' | 'restore') {
    await this.write(operation);
  }
  private lifecycleCommand(operation: string): operation is LifecycleMutation['operation'] {
    return operation === 'delete' || operation === 'restore';
  }
  private async write(operation: Mutation['operation'] | LifecycleMutation['operation'], visibility?: Visibility) {
    if (!this.current() || !this.ownerCanWrite()) return;
    const { saved, draft, loaded, busy, conflict } = this.state;
    if (!saved || !draft || busy || conflict) return;
    const lifecycle = this.lifecycleCommand(operation);
    if (lifecycle) {
      if (operation === 'delete' && this.dirty()) return;
      const csrf = this.ownerCsrf();
      if (this.ownerObservation && !hasValidOwnerCsrfToken(csrf)) return;
    } else if (!loaded.permissions[operation === 'save' ? 'configure' : 'publish']) return;
    if (operation === 'publish' && this.dirty()) return;
    if (this.attempt && this.lifecycleCommand(this.attempt.input.operation) !== lifecycle) return;
    if (operation === 'save') {
      // Existing unavailable saved IDs can be retained; new choices come only from the actual release.
      const filters = new Set([
        ...saved.configuration.scope,
        ...(loaded.options.scopes.kind === 'ready' ? loaded.options.scopes.value.ids : []),
      ]);
      const violations = configurationErrors(draft, filters);
      if (violations.length) {
        this.update({ violations });
        return;
      }
    }
    if (!validRevision(saved.zone.revision)) {
      this.update({ failure: { kind: 'failure', status: 400, code: 'invalid_revision' } });
      return;
    }
    const csrf = this.ownerCsrf();
    const request = lifecycle
      ? ({ operation, csrf } as const)
      : operation === 'save'
        ? ({ operation, body: structuredClone(draft) } as const)
        : ({ operation, body: { visibility: visibility! } } as const);
    const signature = JSON.stringify([saved.zone.id, saved.zone.revision, request]);
    if (this.attempt?.signature !== signature)
      this.attempt = {
        signature,
        input: { ...request, id: saved.zone.id, revision: saved.zone.revision, key: this.key() },
      };
    this.update({ busy: true, failure: undefined, preview: undefined, notice: undefined, violations: [] });
    let result: Result<ZoneOwned | LifecycleReading>;
    let received = true;
    try {
      if (!this.current() || !this.ownerCanWrite()) return;
      result = lifecycle
        ? await this.transport.lifecycle(structuredClone(this.attempt.input as LifecycleMutation))
        : await this.transport.mutate(structuredClone(this.attempt.input as Mutation));
    } catch {
      result = this.localFailure();
      received = false;
    }
    if (!this.current() || (received && !this.matchesOwner(result))) return;
    if (result.kind === 'ready') {
      this.attempt = undefined;
      const zone = lifecycle
        ? {
            ...saved.zone,
            revision: result.value.revision,
            deletedAt: operation === 'restore' ? null : (result.value.deletedAt ?? saved.zone.deletedAt),
            restoreUntil: operation === 'restore' ? null : (result.value.restoreUntil ?? saved.zone.restoreUntil),
          }
        : (result.value as ZoneOwned);
      const next = { ...(lifecycle ? structuredClone(saved) : structuredClone(draft)), zone };
      this.update({
        saved: next,
        loaded: { ...loaded, resource: { kind: 'ready', value: next } },
        busy: false,
        notice: operation === 'save' ? 'saved' : operation === 'publish' ? 'published' : undefined,
      });
    } else {
      // An uncertain network result may already have committed. Read before offering a retry.
      let current: Loaded | undefined;
      try {
        if (!this.current()) return;
        current = await this.transport.load();
      } catch {
        /* Keep the draft and the original retry request. */
      }
      if (!this.current()) return;
      if (current && !this.matchesOwner(current)) return;
      this.update({
        busy: false,
        failure: result,
        ...(result.status === 412 ||
        (current?.resource.kind === 'ready' && current.resource.value.zone.revision !== saved.zone.revision)
          ? { conflict: current ?? { ...loaded, resource: unavailable } }
          : {}),
        ...(current ? { loaded: { ...current, resource: loaded.resource } } : {}),
      });
    }
  }
  async preview(route: string) {
    if (!this.current()) return;
    if (
      this.state.busy ||
      this.state.conflict ||
      this.dirty() ||
      !this.state.saved?.configuration.pages.some((page) => page.route === route)
    )
      return;
    this.update({ busy: true, preview: undefined, notice: undefined });
    try {
      if (!this.current()) return;
      const preview = await this.transport.preview(route);
      if (!this.current() || !this.matchesOwner(preview)) return;
      this.update({ preview, busy: false });
    } catch {
      if (!this.current()) return;
      this.update({ preview: this.localFailure(), busy: false });
    }
  }
  async moreCollections() {
    if (!this.current()) return;
    const current = this.state.loaded.options.collections;
    if (this.state.busy || current.kind !== 'ready' || !current.value.next) return;
    this.update({ busy: true });
    let result: Options['collections'];
    let received = true;
    try {
      if (!this.current()) return;
      result = await this.transport.collections(current.value.next);
    } catch {
      result = this.localFailure();
      received = false;
    }
    if (!this.current() || (received && !this.matchesOwner(result))) return;
    if (result.kind === 'ready') {
      const items = [
        ...new Map([...current.value.items, ...result.value.items].map((item) => [item.id, item])).values(),
      ];
      this.update({
        busy: false,
        loaded: {
          ...this.state.loaded,
          options: {
            ...this.state.loaded.options,
            collections: { kind: 'ready', value: { items, next: result.value.next } },
          },
        },
      });
    } else this.update({ busy: false, failure: result });
  }
}
