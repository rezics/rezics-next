import { useMemo } from 'react';
import { ContainerLifecycleControls } from '../../../community/container-lifecycle-controls';
import type {
  ContainerLifecycleAdapter,
  ContainerTarget,
  LifecycleSnapshot,
} from '../../../community/container-lifecycle';
import realm from '../../../kernel/recorded/realm.json';

export type Scenario =
  | 'active'
  | 'removed'
  | 'uncertain'
  | 'denied'
  | 'conflict'
  | 'orphaned'
  | 'read-only'
  | 'loading'
  | 'unavailable';
export const exampleTarget: ContainerTarget = { kind: 'realm', id: realm.realm.realmId };
export const exampleTitle = realm.realm.title;

/** Isolated presentation fixtures, never installed in the runtime client or evidence of native authority. */
export function lifecycleExampleAdapter(scenario: Scenario): ContainerLifecycleAdapter {
  let snapshot: LifecycleSnapshot = {
    target: exampleTarget,
    head: realm.realm.headRevisionId,
    version: '0',
    contextId: realm.realm.contextId,
    state: scenario === 'orphaned' ? 'orphaned' : scenario === 'removed' ? 'removed' : 'active',
    actions:
      scenario === 'orphaned' || scenario === 'read-only' ? [] : scenario === 'removed' ? ['restore'] : ['remove'],
  };
  let attempts = 0;
  return {
    read: async (target) => {
      if (target.kind !== exampleTarget.kind || target.id !== exampleTarget.id || scenario === 'unavailable')
        return { kind: 'unavailable' };
      if (scenario === 'loading') return new Promise(() => {});
      return { kind: 'ready', snapshot };
    },
    change: async (intent) => {
      if (intent.target.id !== exampleTarget.id || intent.target.kind !== exampleTarget.kind)
        return { kind: 'unavailable' };
      attempts++;
      if (scenario === 'uncertain' && attempts === 1) throw new Error('Lost response');
      if (scenario === 'denied') return { kind: 'refused', status: 404, code: 'not_found' };
      if (scenario === 'conflict') {
        snapshot = { ...snapshot, version: String(BigInt(snapshot.version!) + 1n) };
        return { kind: 'refused', status: 412, code: 'precondition_failed' };
      }
      snapshot = {
        ...snapshot,
        version: String(BigInt(snapshot.version!) + 1n),
        state: intent.action === 'remove' ? 'removed' : 'active',
        actions: intent.action === 'remove' ? ['restore'] : ['remove'],
      };
      return {
        kind: 'confirmed',
        target: exampleTarget,
        action: intent.action,
        contextId: snapshot.contextId,
        head: snapshot.head,
      };
    },
    // No independently authorized Semantic destination is available in these fixtures.
    destination: async () => ({ kind: 'unavailable' }),
  };
}

export function LifecycleExample({ scenario = 'active' }: { scenario?: Scenario }) {
  const adapter = useMemo(() => lifecycleExampleAdapter(scenario), [scenario]);
  return <ContainerLifecycleControls key={scenario} target={exampleTarget} title={exampleTitle} adapter={adapter} />;
}
