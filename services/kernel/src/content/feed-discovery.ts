import { ProblemError } from '../http/problem.ts';
import type { DiscoveryUnionHit } from '../search/discovery.ts';
import { routeOf } from '../route/route.ts';
import type { FeedItem } from './feed-contract.ts';

/** Search owns native summaries and final eligibility. Mapping does no owner reads or refills. */
export function feedDiscoveryItem(hit: DiscoveryUnionHit): Extract<FeedItem, { source: 'discovery' }> {
  const { key, summary } = hit;
  if (routeOf(key.id) !== key.route || key.id !== summary.value.id) throw new ProblemError('dependency_unavailable');
  const owner = summary.kind === 'collection' ? 'commerce' : summary.kind === 'space' ? 'content' : key.owner;
  const common = {
    id: `discovery:${owner}:${key.id}`,
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
    case 'collection': {
      if (key.owner !== 'library' || key.kind !== 'collection' || key.id !== summary.value.id)
        throw new ProblemError('dependency_unavailable');
      return {
        ...common,
        key: { owner: 'commerce', kind: 'collection', route: key.route, id: key.id },
        summary: summary.value,
        destination: { kind: 'collection', id: key.id, title: summary.value.title },
      };
    }
    case 'review': {
      if (key.owner !== 'content' || key.kind !== 'review' || key.id !== summary.value.id)
        throw new ProblemError('dependency_unavailable');
      return {
        ...common,
        key: { owner: 'content', kind: 'review', route: key.route, id: key.id },
        summary: summary.value,
        destination: { kind: 'thread', id: key.id, title: summary.value.title },
      };
    }
    case 'space': {
      if (key.owner !== 'community' || key.kind !== 'space' || key.id !== summary.value.id)
        throw new ProblemError('dependency_unavailable');
      return {
        ...common,
        key: { owner: 'content', kind: 'space', route: key.route, id: key.id },
        summary: summary.value,
        destination: {
          kind: 'space',
          id: key.id,
          title: summary.value.title,
          address: summary.value.address,
        },
      };
    }
    default:
      // Also refuse unknown runtime input instead of treating it as an Account.
      summary satisfies never;
      throw new ProblemError('dependency_unavailable');
  }
}
