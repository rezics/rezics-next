import type { SubjectRead } from '@rezics/client';
import { gameReaderEntry } from '../../catalogue/game-reader/model';
import { isScreenType } from '../../catalogue/screen-profile';
import type { RelationDefinition } from '../../../subject/relations';
import type { Related, Subject } from '../../../subject/types';

export type ShowcaseWorkKind = 'visual-novel' | 'game' | 'screen' | 'book';

type Statement = NonNullable<SubjectRead['subject']['statements'][string]>[number];
type RelatedSubject = NonNullable<Related[string]>;

export type WorkDestination = {
  id: string;
  property: string;
  statement: Statement;
  relation: RelationDefinition;
  target: RelatedSubject;
  kind: ShowcaseWorkKind;
};

/** Only the work identities already disclosed beside this Subject's native statements qualify. */
export function showcaseWorkKind(type: string | undefined, types: readonly string[] = []): ShowcaseWorkKind | undefined {
  const declared = [type, ...types].filter((value): value is string => typeof value === 'string');
  if (declared.includes('wd:Q689445')) return 'visual-novel';
  if (declared.includes('schema:Book')) return 'book';
  if (declared.some(isScreenType)) return 'screen';
  if (gameReaderEntry(type ?? '', types)) return 'game';
}

/**
 * Project one bounded Subject read into cross-media work links. A relation without its disclosed target summary
 * cannot become a destination; the existing Relations view remains the bounded continuation.
 */
export function workDestinations(
  subject: Subject,
  related: Related,
  definitions: Record<string, RelationDefinition>,
): WorkDestination[] {
  const destinations: WorkDestination[] = [];
  for (const [property, statements] of Object.entries(subject.statements)) {
    const relation = Object.hasOwn(definitions, property) ? definitions[property] : undefined;
    if (!relation) continue;
    for (const statement of statements ?? []) {
      if (
        statement.property.id !== property ||
        statement.property.data_type !== 'wikibase-item' ||
        statement.value.type !== 'value' ||
        typeof statement.value.content !== 'string'
      )
        continue;
      const id = statement.value.content;
      if (id === subject.id || !Object.hasOwn(related, id)) continue;
      const target = related[id];
      if (!target) continue;
      const kind = showcaseWorkKind(target.type, target.types);
      if (!kind) continue;
      destinations.push({ id, property, statement, relation, target, kind });
      if (destinations.length === 20) return destinations;
    }
  }
  return destinations;
}
