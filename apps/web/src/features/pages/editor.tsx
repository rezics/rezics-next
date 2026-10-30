import { platformRegistry } from '@rezics/composition';
import { Puck, type Config } from '@puckeditor/core';
import { Button } from '@rezics/ui/shadcn/button';
import '@puckeditor/core/puck.css';
import { createElement, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { CompositionDocument, CompositionRegistry, CompositionViolation } from '@rezics/composition';
import { layoutComponents, PageRoot } from './layout';
import { editorConfig, fromComposition, publishErrors, toComposition, type PageEditorData } from './editor-config';
import { PageLocaleProvider } from './data';
import { m } from '../../paraglide/messages.js';
import { presentationEditorDictionary } from './curate-view-editor-messages';

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
      aria-label={m.curation_placeholder_label({ type })}
      className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      role="note"
    >
      <strong className="font-semibold text-foreground">{type}</strong>
      <span className="ms-2">{m.curation_placeholder()}</span>
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
        return createElement(PageLocaleProvider, {
          locale,
          children: createElement(PageRoot, { appearance, children: input.children }),
        });
      },
    },
  } as Config;
}

// Resource editors share the same registry fields, layout renderers and data placeholders.
export { editorConfiguration };

function violationsHeader(children: ReactNode, errors: CompositionViolation[], pointerPrefix: string) {
  return (
    <>
      {children}
      {errors.length > 0 && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
          <p className="mb-2 font-semibold">{m.curation_invalid()}</p>
          <ul className="list-disc space-y-1 ps-5">
            {errors.map(({ pointer, code }, index) => (
              <li key={`${pointer}:${code}:${index}`}>
                <code>
                  {pointerPrefix + pointer || '/'} — {code}
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
  onChange,
  draft,
  pointerPrefix = '',
  publishDisabled = false,
}: {
  document: CompositionDocument;
  locale: string;
  onPublish: (document: CompositionDocument) => void;
  onChange?: (data: PageEditorData) => void;
  draft?: PageEditorData | undefined;
  pointerPrefix?: string;
  publishDisabled?: boolean;
}) {
  const [errors, setErrors] = useState<CompositionViolation[]>([]);
  const config = useMemo(() => editorConfiguration(platformRegistry, locale), [locale]);
  // Puck owns the current mounted editor. A keyed remount restores the parent's per-view snapshot.
  const [data] = useState(() => draft ?? fromComposition(document));

  function handlePublish(edited: PageEditorData) {
    if (publishDisabled) return;
    const violations = publishErrors(platformRegistry, edited);
    setErrors(violations);
    if (violations.length === 0) {
      onChange?.(edited);
      onPublish(toComposition(edited));
    }
  }

  return (
    <Puck
      config={config}
      data={data}
      dictionary={presentationEditorDictionary()}
      onPublish={(edited) => handlePublish(edited as PageEditorData)}
      renderHeaderActions={({ state }) => (
        <Button disabled={publishDisabled} onClick={() => handlePublish(state.data as PageEditorData)}>
          {m.curation_publish()}
        </Button>
      )}
      onChange={(edited) => {
        setErrors([]);
        onChange?.(edited as PageEditorData);
      }}
      overrides={{ header: ({ children }) => violationsHeader(children, errors, pointerPrefix) }}
    />
  );
}
