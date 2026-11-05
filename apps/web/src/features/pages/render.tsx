import { Render } from '@puckeditor/core/rsc';
import { createElement, Fragment, useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react';

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

type PageRenderer = {
  component: PageComponents[string];
  slots: ReadonlySet<string>;
};

/** Pruning and Puck must agree on exactly which components and slots this build supports. */
function pageRenderers(definitions: readonly PageDefinition[], components: PageComponents) {
  const renderers = new Map<string, PageRenderer>();
  const definitionsByType = new Map(definitions.map((definition) => [definition.type, definition]));
  for (const definition of definitionsByType.values()) {
    if (!Object.hasOwn(components, definition.type)) continue;
    const component = components[definition.type];
    if (!component) continue;
    renderers.set(definition.type, { component, slots: new Set(definition.slots ?? []) });
  }
  return renderers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNode(value: unknown): value is PageNode {
  return (
    isRecord(value) && typeof value.type === 'string' && isRecord(value.props) && typeof value.props.id === 'string'
  );
}

/** Drop unavailable subtrees and empty malformed slots, preserving their siblings and slot boundaries. */
function prune(content: unknown, renderers: ReadonlyMap<string, PageRenderer>): PageNode[] {
  if (!Array.isArray(content)) return [];
  const nodes: PageNode[] = [];
  for (const item of content) {
    if (!isNode(item)) continue;
    const renderer = renderers.get(item.type);
    if (!renderer) continue;
    const props: PageNode['props'] = { ...item.props, id: item.props.id };
    for (const slot of renderer.slots) {
      props[slot] = prune(props[slot], renderers);
    }
    nodes.push({ type: item.type, props });
  }
  return nodes;
}

/** Puck's slot render wraps content in a drop zone. Keep only the rendered nodes. */
function SlotContent({ children }: { children?: ReactNode }) {
  return children ?? null;
}

function renderComponent({ component, slots }: PageRenderer) {
  return (props: Record<string, unknown>) => {
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (key === 'puck' || key === 'editMode') continue;
      const value = props[key];
      if (slots.has(key)) {
        next[key] =
          typeof value === 'function'
            ? createElement(value as ComponentType<{ as?: ComponentType<{ children?: ReactNode }> }>, {
                as: SlotContent,
              })
            : null;
      } else {
        next[key] = value;
      }
    }
    return createElement(component, next);
  };
}

function renderRoot(pageRoot: PageDocument['root'], root: PageRoot | undefined) {
  return ({ children }: { children?: ReactNode }) =>
    root ? createElement(root, { ...pageRoot.props, children }) : createElement(Fragment, null, children);
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
  // Stable component types preserve mounted public links and return recovery during private reader updates.
  const { renderers, config } = useMemo(() => {
    const renderers = pageRenderers(definitions, components);
    const configComponents: Record<
      string,
      { fields: Record<string, { type: 'slot' }>; render: (props: Record<string, unknown>) => ReactNode }
    > = Object.create(null);
    for (const [type, renderer] of renderers) {
      const fields: Record<string, { type: 'slot' }> = Object.create(null);
      for (const slot of renderer.slots) fields[slot] = { type: 'slot' };
      configComponents[type] = { fields, render: renderComponent(renderer) };
    }
    // Puck's config type includes editor props. This registry only supplies the render map.
    const config = {
      components: configComponents,
      root: { render: renderRoot(document.root, root) },
    } as ComponentProps<typeof Render>['config'];
    return { renderers, config };
  }, [definitions, components, root, document.root]);
  const content = prune(document.content, renderers);
  return createElement(Render, { config, data: { root: document.root, content } });
}
