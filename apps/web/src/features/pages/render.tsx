import { Render } from '@puckeditor/core/rsc';
import { createElement, Fragment, type ComponentProps, type ComponentType, type ReactNode } from 'react';

/** Structurally the composition registry: a type and the props that hold nested nodes. */
export type PageDefinition = {
  type: string;
  slots?: readonly string[];
};

/** A page component receives the node's props. Each slot prop is a React node. */
export type PageComponents = {
  readonly [type: string]: ComponentType<Record<string, unknown>>;
};

export type PageDocument = {
  root: { props: Record<string, unknown> };
  content: readonly PageNode[];
};

type PageNode = {
  type: string;
  props: { id: string } & Record<string, unknown>;
};

type PageRoot = ComponentType<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNode(value: unknown): value is PageNode {
  return (
    isRecord(value) && typeof value.type === 'string' && isRecord(value.props) && typeof value.props.id === 'string'
  );
}

/** Drop a node, and everything nested in it, when this build cannot render its type. */
function prune(
  content: readonly unknown[],
  definitions: ReadonlyMap<string, PageDefinition>,
  components: PageComponents,
): PageNode[] {
  const nodes: PageNode[] = [];
  for (const item of content) {
    if (!isNode(item)) continue;
    const definition = definitions.get(item.type);
    const component = components[item.type];
    if (!definition || !component) continue;
    const props: PageNode['props'] = { ...item.props, id: item.props.id };
    for (const slot of definition.slots ?? []) {
      const value = props[slot];
      if (Array.isArray(value)) props[slot] = prune(value, definitions, components);
    }
    nodes.push({ type: item.type, props });
  }
  return nodes;
}

/** Puck's slot render wraps content in a drop zone. Keep only the rendered nodes. */
function SlotContent({ children }: { children?: ReactNode }) {
  return children ?? null;
}

function renderComponent(component: PageComponents[string], slots: ReadonlySet<string>) {
  return (props: Record<string, unknown>) => {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (key === 'puck' || key === 'editMode') continue;
      const value = props[key];
      next[key] =
        slots.has(key) && typeof value === 'function'
          ? createElement(value as ComponentType<{ as?: ComponentType<{ children?: ReactNode }> }>, { as: SlotContent })
          : value;
    }
    return createElement(component, next);
  };
}

function renderRoot(page: PageDocument, root: PageRoot | undefined) {
  return ({ children }: { children?: ReactNode }) =>
    root ? createElement(root, { ...page.root.props, children }) : createElement(Fragment, null, children);
}

export function CompositionRender({
  document,
  definitions,
  components,
  root,
}: {
  document: PageDocument;
  definitions: readonly PageDefinition[];
  components: PageComponents;
  root?: PageRoot;
}) {
  const definitionsByType = new Map(definitions.map((definition) => [definition.type, definition]));
  const content = prune(document.content, definitionsByType, components);
  const configComponents: Record<
    string,
    { fields: Record<string, { type: 'slot' }>; render: (props: Record<string, unknown>) => ReactNode }
  > = {};
  for (const definition of definitionsByType.values()) {
    const component = components[definition.type];
    if (!component) continue;
    const slots = definition.slots ?? [];
    const fields: Record<string, { type: 'slot' }> = {};
    for (const slot of slots) fields[slot] = { type: 'slot' };
    configComponents[definition.type] = { fields, render: renderComponent(component, new Set(slots)) };
  }
  // Puck's config type includes editor props. This registry only supplies the render map.
  const config = {
    components: configComponents,
    root: { render: renderRoot(document, root) },
  } as ComponentProps<typeof Render>['config'];
  return createElement(Render, { config, data: { root: document.root, content } });
}
