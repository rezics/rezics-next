import { createFilterConstruction, walkFilter, type FilterDocument } from '@rezics/filter';
import type { ConditionMetadata } from './condition-editor-model';
import { localizedLabel } from './results';

export const PRESET_WINDOW = 12;
export const PRESET_PREVIEW_NODES = 16;
export const PRESET_TEXT = 160;
export const presetText = (text: string) => (text.length > PRESET_TEXT ? `${text.slice(0, PRESET_TEXT)}…` : text);

/** One accepted public release snapshot; expansion and its limits belong to the shared construction. */
export function conditionPresetCatalogue(metadata: ConditionMetadata, locale: string) {
  const construction = createFilterConstruction(metadata);
  const name = (id: string) => {
    const label = localizedLabel(metadata.filters?.[id]?.labels ?? {}, locale);
    return { text: label.text || id, lang: label.lang };
  };
  const choices = Object.keys(metadata.filters ?? {}).map((id) => ({ id, ...name(id) }));
  return {
    choices,
    name,
    window(query: string, page: number) {
      const needle = query.trim().toLowerCase();
      const matches = choices.filter(
        ({ id, text }) => id.includes(query.trim()) || text.toLowerCase().includes(needle),
      );
      const last = Math.max(0, Math.ceil(matches.length / PRESET_WINDOW) - 1);
      const at = Math.min(Math.max(0, page), last);
      return { choices: matches.slice(at * PRESET_WINDOW, (at + 1) * PRESET_WINDOW), page: at, last };
    },
    preview(id: string): { value: FilterDocument; nodes: ReadonlySet<FilterDocument> } | undefined {
      try {
        // The outer AND is the request's existing condition envelope, including its depth charge.
        const expanded = construction.admitFilter({ and: [{ saved: id }] });
        if (!('and' in expanded) || !expanded.and[0]) return;
        const value = expanded.and[0];
        const nodes = new Set<FilterDocument>();
        for (const node of walkFilter(value)) {
          if (nodes.size === PRESET_PREVIEW_NODES) break;
          nodes.add(node);
        }
        return { value, nodes };
      } catch {
        // Missing, obsolete, cyclic and over-limit definitions have no executable approximation.
        return undefined;
      }
    },
    label(id: string) {
      return localizedLabel(metadata.types[id]?.labels ?? metadata.properties[id]?.labels ?? {}, locale);
    },
  };
}
export type ConditionPresetCatalogue = ReturnType<typeof conditionPresetCatalogue>;
