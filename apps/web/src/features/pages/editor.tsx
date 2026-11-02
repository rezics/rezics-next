import { platformRegistry } from '@rezics/composition';
import { Puck, createUsePuck, useGetPuck, type Config, type FieldRenderFunctions } from '@puckeditor/core';
import { Button } from '@rezics/ui/shadcn/button';
import '@puckeditor/core/puck.css';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { CompositionDocument, CompositionRegistry, CompositionViolation } from '@rezics/composition';
import { layoutComponents, PageRoot } from './layout';
import { editorConfig, fromComposition, publishErrors, toComposition, type PageEditorData } from './editor-config';
import { PageLocaleProvider } from './data';
import { m } from '../../paraglide/messages.js';
import { presentationEditorDictionary, presentationMessageOptions } from './curate-view-editor-messages';
import type { CorrectionTarget } from './curate-view-editor-state';

const CorrectionContext = createContext<{
  target: CorrectionTarget | null;
  focused: { current: CorrectionTarget | null };
} | null>(null);
const useEditorPuck = createUsePuck();

function fieldName(path: string[]) {
  return path.reduce(
    (name, part, index) => (/^(0|[1-9][0-9]*)$/u.test(part) ? `${name}[${part}]` : `${name}${index ? '.' : ''}${part}`),
    '',
  );
}

// Keep Puck's array controls and input ownership; open only the requested item's UI state.
const CorrectionArray: FieldRenderFunctions['array'] = ({ children, id, name, value }) => {
  const correction = useContext(CorrectionContext);
  const target = correction?.target;
  const selectedId = useEditorPuck((state) => state.selectedItem?.props.id ?? null);
  const getPuck = useGetPuck();
  useEffect(() => {
    if (
      !target ||
      correction?.focused.current === target ||
      !id ||
      !Array.isArray(value) ||
      selectedId !== (target.component?.id ?? null)
    )
      return;
    const fullName = fieldName(target.field);
    if (!fullName.startsWith(`${name}[`)) return;
    const position = /^\[(0|[1-9][0-9]*)\]/u.exec(fullName.slice(name.length));
    if (!position || Number(position[1]) >= value.length) return;
    const frame = requestAnimationFrame(() => {
      const { appState, dispatch } = getPuck();
      const previous = appState.ui.arrayState[id];
      const items = previous?.items.length
        ? previous.items
        : value.map((_, index) => ({
            _arrayId: crypto.randomUUID(),
            _originalIndex: index,
            _currentIndex: index,
          }));
      const item = items.find((entry) => entry._currentIndex === Number(position[1]));
      if (!item || previous?.openId === item._arrayId) return;
      dispatch({
        type: 'setUi',
        ui: { arrayState: { ...appState.ui.arrayState, [id]: { items, openId: item._arrayId } } },
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [correction, target, selectedId, getPuck, id, name, value]);
  return <>{children}</>;
};

function CorrectionSelection({ children }: { children: ReactNode }) {
  const target = useContext(CorrectionContext)?.target;
  const getPuck = useGetPuck();
  useEffect(() => {
    if (!target) return;
    // Let Puck install its store subscriptions before selecting in a newly mounted editor.
    const frame = requestAnimationFrame(() => {
      const { dispatch, getSelectorForId } = getPuck();
      const itemSelector = target.component ? getSelectorForId(target.component.id) : null;
      if (target.component && !itemSelector) return;
      dispatch({
        type: 'setUi',
        ui: {
          itemSelector: itemSelector ?? null,
          rightSideBarVisible: true,
          leftSideBarVisible: true,
          mobilePanelExpanded: true,
          plugin: { current: 'fields' },
        },
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, getPuck]);
  return <>{children}</>;
}

function CorrectionFields({ children, isLoading }: { children: ReactNode; isLoading: boolean }) {
  const correction = useContext(CorrectionContext);
  const target = correction?.target;
  const selectedId = useEditorPuck((state) => state.selectedItem?.props.id ?? null);
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = region.current;
    if (!element || !target || !correction || isLoading || correction.focused.current === target) return;
    if (selectedId !== (target.component?.id ?? null)) return;
    function focus() {
      if (correction!.focused.current === target) return true;
      // Puck renders separate mobile and desktop field panels. Focus only the visible owner.
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).display === 'none') return false;
      }
      // Compare owned input names; never interpolate a server pointer into a selector or HTML.
      const control = Array.from(element!.querySelectorAll('input, textarea, select')).find(
        (input) =>
          input.getAttribute('name') === fieldName(target!.field) &&
          !input.hasAttribute('disabled') &&
          !input.hasAttribute('readonly'),
      );
      if (control) {
        correction!.focused.current = target!;
        (control as HTMLElement).focus();
        return true;
      }
      return false;
    }
    if (focus()) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [correction, target, selectedId, isLoading]);
  return <div ref={region}>{children}</div>;
}

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

function dataPlaceholder(type: string, locale: string) {
  const options = presentationMessageOptions(locale);
  return () => (
    <div
      aria-label={m.curation_placeholder_label({ type }, options)}
      className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      role="note"
    >
      <strong className="font-semibold text-foreground">{type}</strong>
      <span className="ms-2">{m.curation_placeholder({}, options)}</span>
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
      render: layout ? layoutRenderer(layout, definition.slots) : dataPlaceholder(definition.type, locale),
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

function violationsHeader(
  children: ReactNode,
  errors: CompositionViolation[],
  pointerPrefix: string,
  locale: string,
) {
  const options = presentationMessageOptions(locale);
  return (
    <>
      {children}
      {errors.length > 0 && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
          <p className="mb-2 font-semibold">{m.curation_invalid({}, options)}</p>
          <details>
            <summary>{m.curation_diagnostics({}, options)}</summary>
            <ul className="list-disc space-y-1 ps-5">
              {errors.map(({ pointer, code }, index) => (
                <li key={`${pointer}:${code}:${index}`}>
                  <code>
                    {pointerPrefix + pointer || '/'} — {code}
                  </code>
                </li>
              ))}
            </ul>
          </details>
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
  correction = null,
  onInvalid,
}: {
  document: CompositionDocument;
  locale: string;
  onPublish: (document: CompositionDocument) => void;
  onChange?: (data: PageEditorData) => void;
  draft?: PageEditorData | undefined;
  pointerPrefix?: string;
  publishDisabled?: boolean;
  correction?: CorrectionTarget | null;
  onInvalid?: (errors: CompositionViolation[], document: CompositionDocument) => void;
}) {
  const [errors, setErrors] = useState<CompositionViolation[]>([]);
  const focusedCorrection = useRef<CorrectionTarget | null>(null);
  const correctionContext = useMemo(() => ({ target: correction, focused: focusedCorrection }), [correction]);
  const config = useMemo(() => editorConfiguration(platformRegistry, locale), [locale]);
  const options = presentationMessageOptions(locale);
  // Puck owns the current mounted editor. A keyed remount restores the parent's per-view snapshot.
  const [data] = useState(() => draft ?? fromComposition(document));

  function handlePublish(edited: PageEditorData) {
    if (publishDisabled) return;
    const violations = publishErrors(platformRegistry, edited);
    setErrors(violations);
    if (violations.length) {
      onChange?.(edited);
      onInvalid?.(violations, toComposition(edited));
    }
    if (violations.length === 0) {
      onChange?.(edited);
      onPublish(toComposition(edited));
    }
  }

  return (
    <CorrectionContext.Provider value={correctionContext}>
      <Puck
        config={config}
        data={data}
        dictionary={presentationEditorDictionary(locale)}
        onPublish={(edited) => handlePublish(edited as PageEditorData)}
        renderHeaderActions={({ state }) => (
          <Button disabled={publishDisabled} onClick={() => handlePublish(state.data as PageEditorData)}>
            {m.curation_publish({}, options)}
          </Button>
        )}
        onChange={(edited) => {
          setErrors([]);
          onChange?.(edited as PageEditorData);
        }}
        overrides={{
          header: ({ children }) => violationsHeader(children, errors, pointerPrefix, locale),
          puck: CorrectionSelection,
          fields: CorrectionFields,
          fieldTypes: { array: CorrectionArray },
        }}
      />
    </CorrectionContext.Provider>
  );
}
