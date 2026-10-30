import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type {
  ContainerLifecycleAdapter,
  ContainerTarget,
  LifecycleIntent,
  LifecycleProblem,
} from './container-lifecycle';

const id = v.pipe(v.string(), v.uuid());
const version = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9][0-9]{0,18})$/),
  v.check((value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n),
);
const target = v.strictObject({ kind: v.picklist(['space', 'realm']), id });
export const lifecycleReadSchema = v.strictObject({ target, contextId: v.optional(v.nullable(id)) });
export const lifecycleCommandSchema = v.strictObject({
  target,
  action: v.picklist(['remove', 'restore']),
  expectedHead: id,
  expectedVersion: version,
  idempotencyKey: id,
  reason: v.pipe(
    v.string(),
    v.check((value) => [...value].length <= 1024 && !value.includes('\0')),
  ),
  contextId: v.nullable(id),
});
export const lifecycleDestinationSchema = v.strictObject({ target, contextId: v.nullable(id) });

type RealmEndpoint = ReturnType<KernelClient['realms']>;
type NativeLifecycle = NonNullable<Awaited<ReturnType<RealmEndpoint['lifecycle']['get']>>['data']>['container'];
type Observation = {
  head: string;
  contextId: string | null;
  spaceId: string;
  realmId: string | null;
  orphaned: boolean;
};
type Reply = { status: number; error: unknown };
function refused(reply: Reply): LifecycleProblem | { kind: 'unavailable' } {
  if (reply.status < 400 || reply.status >= 500) return { kind: 'unavailable' };
  const value = reply.error && typeof reply.error === 'object' && 'value' in reply.error ? reply.error.value : null;
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string')
    return { kind: 'unavailable' };
  return { kind: 'refused', status: reply.status, code: value.code };
}
function matches(container: NativeLifecycle, anchor: ContainerTarget) {
  return container.kind === anchor.kind && container.id === anchor.id;
}
function sameLifecycle(a: NativeLifecycle, b: NativeLifecycle) {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.headRevisionId === b.headRevisionId &&
    a.version === b.version &&
    a.state === b.state
  );
}

/** Generated mounted methods only. Native flags decide role, remover, clock and platform eligibility. */
export function nativeContainerLifecycleAdapter(
  client: KernelClient,
  authorization: string,
  locale: string,
): ContainerLifecycleAdapter {
  const auth = { headers: { authorization } };
  async function lifecycle(anchor: ContainerTarget) {
    return anchor.kind === 'space'
      ? client.spaces({ spaceId: anchor.id }).lifecycle.get(auth)
      : client.realms({ realmId: anchor.id }).lifecycle.get(auth);
  }
  async function ordinary(anchor: ContainerTarget): Promise<Observation | null> {
    if (anchor.kind === 'realm') {
      const response = await client.realms({ realmId: anchor.id }).get(auth);
      if (response.error || !response.data) return null;
      const realm = response.data.realm;
      if (realm.realmId !== anchor.id || realm.state !== 'active') return null;
      return {
        head: realm.headRevisionId,
        contextId: realm.contextId,
        spaceId: realm.spaceId,
        realmId: realm.realmId,
        orphaned: realm.ownershipState === 'orphaned' || realm.governanceReadOnly,
      };
    }
    const response = await client.spaces({ spaceId: anchor.id }).get(auth);
    if (response.error || !response.data) return null;
    const space = response.data.space;
    if (space.spaceId !== anchor.id || space.state !== 'active') return null;
    if (space.realmId === null)
      return { head: space.headRevisionId, contextId: null, spaceId: space.spaceId, realmId: null, orphaned: false };
    const realm = await ordinary({ kind: 'realm', id: space.realmId });
    if (!realm || realm.spaceId !== space.spaceId) return null;
    return { ...realm, head: space.headRevisionId, orphaned: false };
  }
  // This is a bounded consumer comparison of native reads, not a new binding/permission authority.
  // Both lifecycle versions are required even when a remove/restore cycle leaves editorial heads unchanged.
  async function destinationBinding(anchor: ContainerTarget) {
    const current = await ordinary(anchor);
    if (!current || !current.contextId || !current.realmId) return null;
    const space = await client.spaces({ spaceId: current.spaceId }).get(auth);
    if (
      space.error ||
      !space.data ||
      space.data.space.spaceId !== current.spaceId ||
      space.data.space.realmId !== current.realmId
    )
      return null;
    const realm = await client.realms({ realmId: current.realmId }).get(auth);
    if (
      realm.error ||
      !realm.data ||
      realm.data.realm.realmId !== current.realmId ||
      realm.data.realm.spaceId !== current.spaceId ||
      realm.data.realm.contextId !== current.contextId
    )
      return null;
    const spaceLifecycle = await lifecycle({ kind: 'space', id: current.spaceId });
    const realmLifecycle = await lifecycle({ kind: 'realm', id: current.realmId });
    if (spaceLifecycle.error || !spaceLifecycle.data || realmLifecycle.error || !realmLifecycle.data) return null;
    const s = spaceLifecycle.data.container;
    const r = realmLifecycle.data.container;
    if (
      !matches(s, { kind: 'space', id: current.spaceId }) ||
      !matches(r, { kind: 'realm', id: current.realmId }) ||
      s.state !== 'active' ||
      r.state !== 'active' ||
      s.headRevisionId !== space.data.space.headRevisionId ||
      r.headRevisionId !== realm.data.realm.headRevisionId ||
      current.head !== (anchor.kind === 'space' ? s.headRevisionId : r.headRevisionId)
    )
      return null;
    return {
      contextId: current.contextId,
      realmId: current.realmId,
      spaceId: current.spaceId,
      spaceHead: s.headRevisionId,
      realmHead: r.headRevisionId,
      spaceVersion: s.version,
      realmVersion: r.version,
    };
  }
  return {
    async read(anchor, observedContextId = null) {
      const before = await lifecycle(anchor);
      if (before.error || !before.data) return refused(before);
      const container = before.data.container;
      if (!matches(container, anchor)) return { kind: 'unavailable' };
      if (container.state === 'removed') {
        // The ordinary reader intentionally withholds removed containers. A retained pointer is data only.
        return {
          kind: 'ready',
          snapshot: {
            target: anchor,
            head: container.headRevisionId,
            version: container.version,
            state: 'removed',
            contextId: observedContextId,
            actions: container.mayRestore ? ['restore'] : [],
          },
        };
      }
      const current = await ordinary(anchor);
      if (!current || current.head !== container.headRevisionId) return { kind: 'unavailable' };
      const admission = await client.viewerActions.post(
        { resources: [{ type: `community.${anchor.kind}`, id: anchor.id }] },
        auth,
      );
      if (admission.error || !admission.data) return refused(admission);
      const action = anchor.kind === 'space' ? 'space:manage' : 'moderation:takedown';
      const admitted = admission.data.resources.some(
        (resource) =>
          resource.type === `community.${anchor.kind}` &&
          resource.id === anchor.id &&
          'viewerActions' in resource &&
          resource.viewerActions.some(
            (entry) => entry.action === action && entry.operations.includes(`${anchor.kind}.remove`),
          ),
      );
      const final = await ordinary(anchor);
      const after = await lifecycle(anchor);
      if (
        !final ||
        JSON.stringify(final) !== JSON.stringify(current) ||
        after.error ||
        !after.data ||
        !sameLifecycle(container, after.data.container)
      )
        return { kind: 'unavailable' };
      return {
        kind: 'ready',
        snapshot: {
          target: anchor,
          head: container.headRevisionId,
          version: container.version,
          contextId: current.contextId,
          state: current.orphaned ? 'orphaned' : 'active',
          actions: !current.orphaned && admitted && after.data.container.mayRemove ? ['remove'] : [],
        },
      };
    },
    async change(intent: LifecycleIntent) {
      const parsed = v.safeParse(lifecycleCommandSchema, intent);
      if (!parsed.success || (intent.action === 'remove' && !intent.reason.trim()))
        return { kind: 'refused', status: 400, code: 'invalid_request' };
      const command = parsed.output;
      const endpoint =
        command.target.kind === 'space'
          ? client.spaces({ spaceId: command.target.id })
          : client.realms({ realmId: command.target.id });
      const headers = {
        authorization,
        'if-match': JSON.stringify(command.expectedHead),
        'idempotency-key': JSON.stringify(command.idempotencyKey),
      };
      const response =
        command.action === 'remove'
          ? await endpoint.removal.post(
              { expectedVersion: command.expectedVersion, reason: command.reason },
              { headers },
            )
          : await endpoint.restoration.post({ expectedVersion: command.expectedVersion }, { headers });
      if (response.error || !response.data) return refused(response);
      const result = response.data.container;
      if (
        result.kind !== command.target.kind ||
        result.id !== command.target.id ||
        result.state !== (command.action === 'remove' ? 'removed' : 'active') ||
        result.headRevisionId !== command.expectedHead ||
        BigInt(result.version) !== BigInt(command.expectedVersion) + 1n
      )
        return { kind: 'unavailable' };
      // This echoes the observed pointer; the acknowledgement supplies no Context or destination authority.
      return {
        kind: 'confirmed',
        target: command.target,
        action: command.action,
        head: result.headRevisionId,
        contextId: command.contextId,
      };
    },
    async destination(anchor, contextId) {
      if (!contextId) return { kind: 'unavailable' };
      const before = await destinationBinding(anchor);
      if (!before || before.contextId !== contextId) return { kind: 'unavailable' };
      const context = await client.contexts({ id: contextId }).get(auth);
      if (context.error || !context.data || context.data.context.id !== contextId) return { kind: 'unavailable' };
      const final = await destinationBinding(anchor);
      if (!final || JSON.stringify(final) !== JSON.stringify(before)) return { kind: 'unavailable' };
      return {
        kind: 'available',
        target: anchor,
        contextId,
        href: `/${locale}/realms/${encodeURIComponent(final.realmId)}`,
      };
    },
  };
}
