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

/** Invalid page addresses stay on the route's existing not-found path. */
export function typeListTargetFromPage(page: string): TypeListTarget | undefined {
  try {
    return typeListTarget(JSON.parse(page));
  } catch {
    return undefined;
  }
}

/** Only a subject list selected inside a Realm uses a private reader admission. */
export function hasSelectedRealmTarget(target: TypeListTarget | undefined): target is TypeListTarget & {
  subject: string;
  realm: string;
} {
  return !!target && 'subject' in target && typeof target.realm === 'string' && target.realm.length > 0;
}

export function typeListHref(locale: string, target: TypeListTarget, node: string, cursor?: string): string {
  const params = new URLSearchParams({ list: node, page: JSON.stringify(target) });
  if (cursor !== undefined) params.set('cursor', cursor);
  return `/${encodeURIComponent(locale)}/search/list?${params}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNode(value: unknown): value is CompositionNode {
  return (
    isRecord(value) && typeof value.type === 'string' && isRecord(value.props) && typeof value.props.id === 'string'
  );
}

export function findTypeList(document: PageDocument, id: string): CompositionNode | undefined {
  const components = new Map(platformRegistry.components.map((component) => [component.type, component]));
  const visit = (nodes: unknown): CompositionNode | undefined => {
    if (!Array.isArray(nodes)) return;
    for (const item of nodes) {
      if (!isNode(item)) continue;
      const component = components.get(item.type);
      if (!component) continue;
      if (item.type === 'TypeList' && item.props.id === id) return item;
      for (const slot of component.slots) {
        const found = visit(item.props[slot]);
        if (found) return found;
      }
    }
  };
  return visit(document.content);
}
