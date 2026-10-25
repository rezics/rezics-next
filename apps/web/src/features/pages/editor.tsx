import { platformRegistry } from '@rezics/composition';
import { Puck, type Config } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import { createElement, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { CompositionDocument, CompositionRegistry, CompositionViolation } from '@rezics/composition';
import { layoutComponents, PageRoot } from './layout';
import { editorConfig, fromComposition, publishErrors, toComposition, type PageEditorData } from './editor-config';

type RenderProps = Record<string, unknown>;
type SlotRenderer = ComponentType<{ as?: ComponentType<{ children?: ReactNode }>; children?: ReactNode }>;

function SlotContent({ children }: { children?: ReactNode }) {
  return children ?? null;
}

function layoutRenderer(component: ComponentType<RenderProps>, slots: readonly string[]) {
  const slotNames = new Set(slots);
  return (input: RenderProps) => {
    const props: RenderProps = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'puck' || key === 'editMode') continue;
      props[key] =
        slotNames.has(key) && typeof value === 'function'
          ? createElement(value as SlotRenderer, { as: SlotContent })
          : value;
    }
    return createElement(component, props);
  };
}

function dataPlaceholder(type: string) {
  return () => (
    <div
      aria-label={`${type} data placeholder`}
      className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      role="note"
    >
      <strong className="font-semibold text-foreground">{type}</strong>
      <span className="ms-2">Page data appears when this page is rendered.</span>
    </div>
  );
}

function editorConfiguration(registry: CompositionRegistry, locale: string): Config {
  const base = editorConfig(registry, { locale });
  const components: Record<string, unknown> = {};
  for (const definition of registry.components) {
    const baseComponent = (base.components as Record<string, Record<string, unknown>>)[definition.type]!;
    const layout = (layoutComponents as Record<string, ComponentType<RenderProps>>)[definition.type];
    components[definition.type] = {
      ...baseComponent,
      render: layout ? layoutRenderer(layout, definition.slots) : dataPlaceholder(definition.type),
    };
  }

  const root = base.root as Record<string, unknown>;
  return {
    ...base,
    components,
    root: {
      ...root,
      render: (input: RenderProps) => {
        const appearance: Record<string, unknown> = {};
        for (const name of Object.keys(base.root?.fields ?? {})) appearance[name] = input[name];
        return createElement(PageRoot, { appearance, children: input.children });
      },
    },
  } as Config;
}

function violationsHeader(children: ReactNode, errors: CompositionViolation[]) {
  return (
    <>
      {children}
      {errors.length > 0 && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
          <p className="mb-2 font-semibold">This page cannot be published.</p>
          <ul className="list-disc space-y-1 ps-5">
            {errors.map(({ pointer, code }, index) => (
              <li key={`${pointer}:${code}:${index}`}>
                <code>
                  {pointer || '/'} — {code}
                </code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function PageEditor({
  document,
  locale,
  onPublish,
}: {
  document: CompositionDocument;
  locale: string;
  onPublish: (document: CompositionDocument) => void;
}) {
  const [errors, setErrors] = useState<CompositionViolation[]>([]);
  const config = useMemo(() => editorConfiguration(platformRegistry, locale), [locale]);
  const data = useMemo(() => fromComposition(document), [document]);

  function handlePublish(edited: PageEditorData) {
    const violations = publishErrors(platformRegistry, edited);
    setErrors(violations);
    if (violations.length === 0) onPublish(toComposition(edited));
  }

  return (
    <Puck
      config={config}
      data={data}
      onPublish={(edited) => handlePublish(edited as PageEditorData)}
      onChange={() => setErrors([])}
      overrides={{ header: ({ children }) => violationsHeader(children, errors) }}
    />
  );
}
