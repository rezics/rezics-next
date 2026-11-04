import {
  platformRegistry,
  profileDigest,
  type CompositionDocument,
  type CompositionNode,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import { profileTemplates, templateViewNames, viewOf, viewPointer, withView, type Template } from './curate';
import { editorConfig, toComposition, type PageEditorData } from './editor-config';
import type { PublicationConfirmation } from './curation-publish';

export type CurationSnapshot = {
  ok: true;
  reader: string;
  digest: string;
  head: number;
  profile: PresentationProfile;
};
export type ViewSelection = { template: Template; view: View };
export type CorrectionTarget = ViewSelection & {
  component: { id: string; type: string } | null;
  field: string[];
  label: string;
  sourceValue: unknown;
};

/** Reject malformed escapes and non-canonical array positions rather than guessing a target. */
function pointerSegments(pointer: string): string[] | null {
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer)) return null;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
}

function nodeAt(nodes: CompositionNode[], segment: string | undefined) {
  return segment !== undefined && /^(0|[1-9][0-9]*)$/u.test(segment) ? nodes[Number(segment)] : undefined;
}

/** Use the installed editor configuration as the authority for editable fields and their labels. */
function editableField(type: string | null, path: string[], locale: string, props: Record<string, unknown>) {
  const config = editorConfig(platformRegistry, { locale });
  let fields = type === null ? config.root?.fields : config.components[type]?.fields;
  const names: string[] = [];
  const labels: string[] = [];
  let value: unknown = props;
  for (let index = 0; index < path.length; index++) {
    const name = path[index]!;
    if (!fields || !Object.hasOwn(fields, name)) return null;
    const field = fields[name]!;
    value =
      value !== null && typeof value === 'object' && Object.hasOwn(value, name)
        ? (value as Record<string, unknown>)[name]
        : undefined;
    names.push(name);
    labels.push(field.label ?? name);
    if (field.type === 'object') {
      fields = field.objectFields;
      // Localized scalar text is edited in the English control, as in fromComposition.
      if (index === path.length - 1 && Object.hasOwn(fields, 'en')) path = [...path, 'en'];
    } else if (field.type === 'array') {
      const position = path[++index];
      if (!position || !/^(0|[1-9][0-9]*)$/u.test(position)) return null;
      if (!Array.isArray(value) || Number(position) >= value.length) return null;
      value = value[Number(position)];
      names.push(position);
      labels.push(String(Number(position) + 1));
      fields = field.arrayFields;
      if (Object.keys(fields).length === 1 && Object.hasOwn(fields, 'value') && index === path.length - 1)
        path = [...path, 'value'];
    } else if (field.type !== 'slot') {
      // JSON-valued controls (filters and object choices) own their entire nested value.
      if (index !== path.length - 1) {
        if (field.type !== 'textarea') return null;
        for (const part of path.slice(index + 1)) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return null;
          value = (value as Record<string, unknown>)[part];
        }
      }
      return { field: names, label: labels.join(' · '), sourceValue: props[names[0]!] };
    } else return null;
  }
  return null;
}

/** Resolve indices only in the exact profile to which the validation response belongs. */
export function resolveCorrection(
  profile: PresentationProfile,
  pointer: string,
  locale: string,
): CorrectionTarget | null {
  const segments = pointerSegments(pointer);
  if (!segments) return null;
  for (const template of profileTemplates(profile)) {
    for (const view of templateViewNames(profile, template)) {
      const prefix = pointerSegments(viewPointer(profile, template, view))!;
      if (!prefix.every((part, index) => segments[index] === part)) continue;
      const path = segments.slice(prefix.length);
      const document = viewOf(profile, template, view)!;
      if (path[0] === 'root' && path[1] === 'props' && path[2] === 'appearance') {
        const appearance = document.root.props.appearance;
        const field = editableField(
          null,
          path.slice(3),
          locale,
          appearance !== null && typeof appearance === 'object' && !Array.isArray(appearance)
            ? (appearance as Record<string, unknown>)
            : {},
        );
        return field ? { template, view, component: null, ...field } : null;
      }
      if (path.shift() !== 'content') return null;
      let node = nodeAt(document.content, path.shift());
      while (node && path[0] === 'props') {
        path.shift();
        const definition = platformRegistry.components.find((entry) => entry.type === node!.type);
        if (!definition) return null;
        const slot = path[0];
        if (slot && definition.slots.includes(slot)) {
          path.shift();
          const children = node.props[slot];
          node = Array.isArray(children) ? nodeAt(children as CompositionNode[], path.shift()) : undefined;
          continue;
        }
        const field = editableField(node.type, path, locale, node.props);
        return field ? { template, view, component: { id: node.props.id, type: node.type }, ...field } : null;
      }
      return null;
    }
  }
  return null;
}

/** Match stable component identity in the current draft, never reuse a failed snapshot's array position. */
export function currentCorrection(profile: PresentationProfile, target: CorrectionTarget): CorrectionTarget | null {
  const document = viewOf(profile, target.template, target.view);
  if (!document) return null;
  if (!target.component) return target;
  const matches: CompositionNode[] = [];
  function visit(nodes: CompositionDocument['content']) {
    for (const node of nodes) {
      if (node.props.id === target.component!.id) matches.push(node);
      const definition = platformRegistry.components.find((entry) => entry.type === node.type);
      for (const slot of definition?.slots ?? []) {
        const children = node.props[slot];
        if (Array.isArray(children)) visit(children as CompositionNode[]);
      }
    }
  }
  visit(document.content);
  if (matches.length !== 1 || matches[0]!.type !== target.component.type) return null;
  // Array item positions have no stable identity. Map them only if that whole property is unchanged.
  if (
    target.field.some((part) => /^(0|[1-9][0-9]*)$/u.test(part)) &&
    JSON.stringify(matches[0]!.props[target.field[0]!]) !== JSON.stringify(target.sourceValue)
  )
    return null;
  return target;
}
export type PresentationDraft = {
  saved: CurationSnapshot;
  profile: PresentationProfile;
  selection: ViewSelection;
  editors: Record<string, PageEditorData>;
};

export function selectionKey({ template, view }: ViewSelection): string {
  return JSON.stringify([template.scope, template.key, view]);
}

export function presentationDraft(saved: CurationSnapshot): PresentationDraft {
  return {
    saved,
    profile: saved.profile,
    selection: { template: { scope: 'generic', key: null }, view: 'overview' },
    editors: {},
  };
}

export function selectTemplate(draft: PresentationDraft, template: Template): PresentationDraft {
  const views = templateViewNames(draft.profile, template);
  if (views.length === 0) return draft;
  return {
    ...draft,
    selection: { template, view: views.includes(draft.selection.view) ? draft.selection.view : 'overview' },
  };
}

/** Keep Puck's editing data too: blank language fields and editor IDs survive a view switch. */
export function editView(draft: PresentationDraft, selection: ViewSelection, data: PageEditorData): PresentationDraft {
  if (!templateViewNames(draft.profile, selection.template).includes(selection.view)) return draft;
  return {
    ...draft,
    profile: withView(draft.profile, selection.template, selection.view, toComposition(data)),
    editors: { ...draft.editors, [selectionKey(selection)]: data },
  };
}

/** Compare composition identity, including when reviewing edits after a retained publication. */
export function hasDraftChanges(
  draft: PresentationDraft,
  baseline: PresentationProfile = draft.saved.profile,
): boolean {
  if (draft.profile === baseline) return false;
  try {
    return profileDigest(draft.profile) !== profileDigest(baseline);
  } catch {
    // An uncanonicalizable edit must not lose its leave warning or be mistaken for a saved draft.
    return true;
  }
}

/** Include Puck's final synchronous edit before deciding whether a publication is necessary. */
export function draftPublicationProfile(
  draft: PresentationDraft,
  edited?: CompositionDocument,
): PresentationProfile | null {
  const profile = edited
    ? withView(draft.profile, draft.selection.template, draft.selection.view, edited)
    : draft.profile;
  return hasDraftChanges({ ...draft, profile }) ? profile : null;
}

export function discardPresentationDraft(draft: PresentationDraft): PresentationDraft {
  const reset = presentationDraft(draft.saved);
  const views = templateViewNames(reset.profile, draft.selection.template);
  return views.includes(draft.selection.view) ? { ...reset, selection: draft.selection } : reset;
}

/** A confirmed retry advances its exact snapshot, while later per-view edits remain unpublished. */
export function confirmPresentationDraft(
  draft: PresentationDraft,
  { intent, result }: PublicationConfirmation,
): PresentationDraft {
  return {
    ...draft,
    saved: { ok: true, reader: intent.reader, profile: intent.profile, digest: result.digest, head: result.head },
  };
}

/** The publication owner supplies the reviewed active snapshot, never an inferred publication receipt. */
export function reviewPresentationDraft(
  draft: PresentationDraft,
  active: CurationSnapshot,
  choice: 'keep' | 'discard',
): PresentationDraft {
  const reviewed = { ...draft, saved: active };
  return choice === 'keep' ? reviewed : discardPresentationDraft(reviewed);
}
