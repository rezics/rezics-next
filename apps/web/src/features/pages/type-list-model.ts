import { isView, platformRegistry, type CompositionNode, type View } from '@rezics/composition';
import type { PageDocument } from './render';

export type TypeListTarget = ({ route: string } | { subject: string; realm?: string } | { account: string }) & {
  view?: View;
};

/** Only page addresses travel in the URL. The server resolves the configured filter and native Source again. */
export function typeListTarget(value: unknown): TypeListTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid list page');
  const target = value as Record<string, unknown>;
  const selectors = ['route', 'subject', 'account'].filter((key) => typeof target[key] === 'string');
  if (selectors.length !== 1 || Object.keys(target).some((key) => ![selectors[0], 'realm', 'view'].includes(key)))
    throw new Error('Invalid list page');
  if (target.realm !== undefined && (selectors[0] !== 'subject' || typeof target.realm !== 'string'))
    throw new Error('Invalid list context');
  if (target.view !== undefined && (selectors[0] === 'route' || !isView(target.view)))
    throw new Error('Invalid list view');
  // Kernel applies the canonical UUID, handle and route grammar before resolving any page.
  return target as TypeListTarget;
}

export function typeListHref(locale: string, target: TypeListTarget, node: string, cursor?: string): string {
  const params = new URLSearchParams({ list: node, page: JSON.stringify(target) });
  if (cursor !== undefined) params.set('cursor', cursor);
  return `/${encodeURIComponent(locale)}/search/list?${params}`;
}

export function findTypeList(document: PageDocument, id: string): CompositionNode | undefined {
  const components = new Map(platformRegistry.components.map((component) => [component.type, component]));
  const visit = (nodes: readonly CompositionNode[]): CompositionNode | undefined => {
    for (const node of nodes) {
      if (node.type === 'TypeList' && node.props.id === id) return node;
      for (const slot of components.get(node.type)?.slots ?? []) {
        const found = visit(node.props[slot] as CompositionNode[]);
        if (found) return found;
      }
    }
  };
  return visit(document.content);
}
