import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { PropertyDefinition, TypeDefinition } from '@rezics/definitions';
import { checkSubjectStructure, type Violation } from '@rezics/definitions/validate';
import type { StatementInput } from './statement-editor';

/** The generated POST body is the public ItemInputSchema, not an editor-specific wire format. */
export type InitialSubject = Pick<
  Parameters<KernelClient['subjects']['post']>[0],
  'type' | 'labels' | 'descriptions' | 'aliases'
> & { statements?: Record<string, StatementInput[]> };
export type CreateSubjectCommand = { item: InitialSubject; key: string };
export type CreateType = {
  id: string;
  label: string;
  description: string;
  labelLanguage?: string;
  descriptionLanguage?: string;
  /** Structural bases from the exact Type descriptor; admission consumers do not invent them. */
  bases?: string[];
  /** Present only on an exact current Type descriptor, never on a bounded directory page. */
  releaseDigest?: string;
  definition?: TypeDefinition;
  propertyDefinitions?: Record<string, PropertyDefinition>;
  /** Exact current descriptor only: an existing feature-specific creator owns this Type. */
  specializedPath?: string;
};
export type CreateDefinitions = { ok: true; types: CreateType[] } | { ok: false };
export type TypeDirectoryQuery = { query?: string; typeId?: string; cursor?: string };
export type TypeDirectoryPage =
  | { ok: true; types: CreateType[]; next: string | null }
  | { ok: false; reason: 'stale' | 'unavailable' };
export type TypeDescriptorRead = { ok: true; type: CreateType } | { ok: false; reason: 'missing' | 'unavailable' };
export type TypeDirectoryTransport = {
  page: (input: TypeDirectoryQuery) => Promise<TypeDirectoryPage>;
  descriptor: (typeId: string) => Promise<TypeDescriptorRead>;
};
export type CreateFailure = {
  ok: false;
  reason: 'signed-out' | 'denied' | 'invalid' | 'conflict' | 'unavailable';
  errors?: Pick<Violation, 'pointer' | 'code'>[];
  refreshDefinitions?: boolean;
};
export type CreatedReader =
  | { state: 'ready'; href: string; identity?: { id: string; type: string; label: string } }
  | { state: 'concealed' | 'unavailable' | 'stale' | 'denied' };
export type CreateResult = CreateFailure | { ok: true; id: string; reader: CreatedReader };
export type CreateTransport = {
  definitions?: (refresh?: boolean) => Promise<CreateDefinitions>;
  typeDirectory?: TypeDirectoryTransport;
  submit: (command: CreateSubjectCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
};
export type TermDraft = { language: string; label: string; description: string; aliases: string };

/** Labels/help come from emitted metadata. Data-language choices never relabel the definitions. */
export function createTypes(
  release: {
    types: Record<
      string,
      { labels?: Record<string, string>; descriptions?: Record<string, string>; bases?: readonly string[] }
    >;
  },
  locale: string,
): CreateType[] {
  return Object.entries(release.types)
    .flatMap(([id, definition]) => {
      const label = pickText(definition.labels ?? {}, locale).text;
      if (!label) return [];
      const bases = (definition.bases ?? []).filter((base) => typeof base === 'string' && base.length > 0);
      return [
        {
          id,
          label,
          description: pickText(definition.descriptions ?? {}, locale).text,
          ...(bases.length ? { bases } : {}),
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

export function initialTerms(type: string, rows: TermDraft[]): { item: InitialSubject; errors: Violation[] } {
  const labels: Record<string, string> = Object.create(null);
  const descriptions: Record<string, string> = Object.create(null);
  const aliases: Record<string, string[]> = Object.create(null);
  const errors: Violation[] = [];
  const languages = new Set<string>();
  for (const row of rows) {
    const language = row.language.trim();
    const pointer = `/labels/${language.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (languages.has(language)) errors.push({ pointer, code: 'invalid_format' });
    languages.add(language);
    // A row needs a label even when the optional terms are empty.
    labels[language] = row.label.trim();
    if (row.description.trim()) descriptions[language] = row.description.trim();
    const values = row.aliases
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length) aliases[language] = values;
  }
  const item: InitialSubject = { type, labels, descriptions, aliases };
  errors.push(...checkSubjectStructure(item).violations);
  if (!type) errors.push({ pointer: '/type', code: 'required' });
  return { item, errors };
}
