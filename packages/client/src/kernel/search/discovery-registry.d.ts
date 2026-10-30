import type {
  DiscoveryCondition, DiscoveryDomain, DiscoveryKey, DiscoveryRegistry, DiscoveryRegistryOptions,
  DiscoveryTruth, KindCountEvidence,
} from './discovery.ts';
export declare function createDiscoveryRegistry(options: DiscoveryRegistryOptions): DiscoveryRegistry;
export declare function discoveryDomain(registry: DiscoveryRegistry, kind: string, domain: DiscoveryDomain): 'applicable' | 'not_applicable';
export declare function evaluateDiscoveryCondition(
  registry: DiscoveryRegistry,
  kind: string,
  condition: DiscoveryCondition,
  evidence: (leaf: Extract<DiscoveryCondition, { domain: DiscoveryDomain }>) => DiscoveryTruth,
): DiscoveryTruth;
export declare function validateKindCountEvidence(registry: DiscoveryRegistry, count: KindCountEvidence): KindCountEvidence;
