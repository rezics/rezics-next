import { platformRegistry, validateZoneStarter, type CompositionViolation } from '@rezics/composition';
import type {
  ZoneConfigurationResponse,
  ZoneConfigureInput,
  ZoneOwned,
  ZonePageResponse,
  ZonePublishInput,
} from '../../../../../../services/kernel/src/zones/contract';

export type { ZoneConfigurationResponse, ZoneConfigureInput, ZoneOwned, ZonePageResponse };
export type Visibility = ZonePublishInput['visibility'];
export type Failure = {
  kind: 'failure';
  status: number;
  code: string;
  errors?: { pointer: string; code: string }[];
  retryAfter?: string;
};
export type Result<T> = { kind: 'ready'; value: T } | Failure;
export type Permissions = { configure: boolean; publish: boolean; available: boolean; failure?: Failure };
export type Options = {
  scopes: Result<{ release: string; ids: string[] }>;
  collections: Result<{ items: { id: string; title: string }[]; next: string | null }>;
};
export type Loaded = { resource: Result<ZoneConfigurationResponse>; permissions: Permissions; options: Options };
export type Mutation = {
  id: string;
  revision: string;
  key: string;
} & ({ operation: 'save'; body: ZoneConfigureInput } | { operation: 'publish'; body: ZonePublishInput });
export type Preview = Result<ZonePageResponse> | { kind: 'preparing'; retryAfter: string };
export type Transport = {
  load(): Promise<Loaded>;
  mutate(input: Mutation): Promise<Result<ZoneOwned>>;
  preview(route: string): Promise<Preview>;
  collections(cursor: string): Promise<Options['collections']>;
};

export const unavailable: Failure = { kind: 'failure', status: 503, code: 'dependency_unavailable' };
export const validRevision = (value: string) => /^[1-9][0-9]*$/.test(value);

/** Navigation is derived from sorted configured routes; it has no second editable store. */
export function configurationErrors(draft: ZoneConfigureInput, filters: ReadonlySet<string>): CompositionViolation[] {
  const errors = validateZoneStarter(platformRegistry, draft.configuration, { filters });
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
  private attempt: { signature: string; input: Mutation } | undefined;
  constructor(
    private transport: Transport,
    loaded: Loaded,
    private key = () => crypto.randomUUID(),
  ) {
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
  setTransport(transport: Transport) {
    this.transport = transport;
  }
  clearPreview() {
    this.update({ preview: undefined });
  }
  private update(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  dirty() {
    const { saved, draft } = this.state;
    return (
      !!draft &&
      !!saved &&
      JSON.stringify(draft) !== JSON.stringify({ configuration: saved.configuration, mounts: saved.mounts })
    );
  }
  edit(draft: ZoneConfigureInput) {
    if (this.state.busy || this.state.conflict || !this.state.loaded.permissions.configure) return;
    this.update({
      draft: structuredClone(draft),
      failure: undefined,
      violations: [],
      preview: undefined,
      notice: undefined,
    });
  }
  async refresh() {
    if (this.state.busy) return;
    this.update({ busy: true });
    try {
      const loaded = await this.transport.load();
      if (this.state.draft) {
        this.update({ conflict: loaded, busy: false });
      } else this.accept(loaded);
    } catch {
      this.update({ busy: false, failure: unavailable });
    }
  }
  private accept(loaded: Loaded) {
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
  private async write(operation: 'save' | 'publish', visibility?: Visibility) {
    const { saved, draft, loaded, busy, conflict } = this.state;
    if (!saved || !draft || busy || conflict || !loaded.permissions[operation === 'save' ? 'configure' : 'publish'])
      return;
    if (operation === 'publish' && this.dirty()) return;
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
    const request =
      operation === 'save'
        ? ({ operation, body: structuredClone(draft) } as const)
        : ({ operation, body: { visibility: visibility! } } as const);
    const signature = JSON.stringify([saved.zone.revision, request]);
    if (this.attempt?.signature !== signature)
      this.attempt = {
        signature,
        input: { ...request, id: saved.zone.id, revision: saved.zone.revision, key: this.key() },
      };
    this.update({ busy: true, failure: undefined, preview: undefined, notice: undefined, violations: [] });
    let result: Result<ZoneOwned>;
    try {
      result = await this.transport.mutate(this.attempt.input);
    } catch {
      result = unavailable;
    }
    if (result.kind === 'ready') {
      this.attempt = undefined;
      const next = { ...structuredClone(draft), zone: result.value };
      this.update({
        saved: next,
        loaded: { ...loaded, resource: { kind: 'ready', value: next } },
        busy: false,
        notice: operation === 'save' ? 'saved' : 'published',
      });
    } else {
      // An uncertain network result may already have committed. Read before offering a retry.
      let current: Loaded | undefined;
      try {
        current = await this.transport.load();
      } catch {
        /* Keep the draft and the original retry request. */
      }
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
    if (
      this.state.busy ||
      this.state.conflict ||
      this.dirty() ||
      !this.state.saved?.configuration.pages.some((page) => page.route === route)
    )
      return;
    this.update({ busy: true, preview: undefined, notice: undefined });
    try {
      this.update({ preview: await this.transport.preview(route), busy: false });
    } catch {
      this.update({ preview: unavailable, busy: false });
    }
  }
  async moreCollections() {
    const current = this.state.loaded.options.collections;
    if (this.state.busy || current.kind !== 'ready' || !current.value.next) return;
    this.update({ busy: true });
    let result: Options['collections'];
    try {
      result = await this.transport.collections(current.value.next);
    } catch {
      result = unavailable;
    }
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
