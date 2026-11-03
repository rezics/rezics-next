import { ProblemError } from '../http/problem.ts';
import type { DiscoveryHit } from '../search/discovery.ts';
import type { FeedItem } from './feed-contract.ts';

/** Search owns native summaries and final eligibility. Mapping does no owner reads or refills. */
export function feedDiscoveryItem(hit: DiscoveryHit): Extract<FeedItem, { source: 'discovery' }> {
  const { key, summary } = hit;
  const common = {
    id: `discovery:${key.owner}:${key.id}`,
    source: 'discovery' as const,
    occurredAt: null,
  };
  switch (summary.kind) {
    case 'subject': {
      if (key.owner !== 'semantic' || key.kind !== summary.value.type || key.id !== summary.value.id)
        throw new ProblemError('dependency_unavailable');
      return {
        ...common,
        key: {
          owner: 'semantic',
          kind: key.kind,
          route: key.route,
          id: key.id,
        },
        summary: summary.value,
        destination: {
          kind: 'subject',
          id: key.id,
          title: summary.value.label?.value ?? null,
        },
      };
    }
    case 'account': {
      if (key.owner !== 'accounts' || key.kind !== 'account' || key.id !== summary.value.id)
        throw new ProblemError('dependency_unavailable');
      return {
        ...common,
        key: {
          owner: 'accounts',
          kind: 'account',
          route: key.route,
          id: key.id,
        },
        summary: summary.value,
        destination: {
          kind: 'account',
          id: key.id,
          title: summary.value.displayName ?? summary.value.handle,
        },
      };
    }
    default:
      // A new Search variant must acquire an explicit Feed schema/mapping together.
      // Also refuse unknown runtime input instead of treating it as an Account.
      summary satisfies never;
      throw new ProblemError('dependency_unavailable');
  }
}
