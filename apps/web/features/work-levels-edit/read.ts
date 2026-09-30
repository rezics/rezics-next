import { reader } from '../work-page/read.ts';
import { labelFor } from '../work-levels/relation-rows.ts';
import type { Loaded } from '../work-levels/types.ts';
import { isRelationKind, type KindOption, relationKinds } from './kinds.ts';

// Reads for the edit pages beyond what Work levels (G-837) already reads: the relation kinds
// and their labels from Main's lexicon. Failures stay local, as in `work-levels/read.ts`.

/** The relation kinds with the label Main renders in the reader's language; a kind Main cannot label is not offered. */
export async function readKindOptions(locale: string): Promise<Loaded<KindOption[]>> {
  const { main, actingSubject } = await reader();
  if (!actingSubject) return { ok: false, failure: 'identity' };
  try {
    const definitions = await Promise.all(relationKinds.map(async ({ key }) => {
      const { data, error } = await main.v1.lexicon.definitions({ key }).get({ query: { actingSubject } });
      return error || !data ? null : { key, data };
    }));
    const found = definitions.flatMap(item => (item && isRelationKind(item.key) ? [item] : []));
    const options: KindOption[] = [];
    // One call per definition: a rendering is seen from one role, and the subject's side is the one that labels the other Work.
    await Promise.all(found.map(async ({ key, data }) => {
      const subject = data.workSubjectRole;
      if (!subject) return;
      const { data: batch } = await main.v1.lexicon.presentations.get({ query: { actingSubject,
        definitions: data.definition, revisions: data.revision, viewingRole: subject, languages: locale } });
      const rendering = batch?.items[0]?.renderings.find(item => item.viewingRole === subject);
      const projection = rendering?.projections.find(item => item.fromRole === subject);
      const label = projection ? labelFor(projection, 1) : null;
      if (label?.text) options.push({ key, label: label.text.value, language: label.text.language });
    }));
    const order = relationKinds.map(kind => kind.key as string);
    return { ok: true, data: options.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
