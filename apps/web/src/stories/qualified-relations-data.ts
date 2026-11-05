import { qualifiedRelationsPage } from '../kernel/fake/qualified-relations';
import type { Stmt } from '../features/pages/shared';

export const longCredit = {
  person: 'Alexandra Player — performer in the original production and the restored international edition',
  role: 'Principal voice performer and narrator of the extended archival recollections',
  character: 'The Traveller from the distant northern archipelago and the keeper of its oral histories',
  name: '旅人の声と回想場面の語りを担当したアレクサンドラ・プレイヤー',
};

/** Vary text lengths in the populated response; keep its actual statement and related target identities. */
export function longCreditPage() {
  const page = structuredClone(qualifiedRelationsPage());
  // Exercise released, localized headings rather than this fixture's authored English heading.
  delete page.document.content.find((node) => node.props.id === 'cast')!.props.title;
  for (const read of Object.values(page.reads)) {
    const body = read.body as {
      relations?: {
        label: string;
        summary: { label: { value: string } };
        statement: Stmt;
        related: Record<string, { label: { value: string } }>;
      }[];
    };
    for (const row of body.relations ?? []) {
      if (row.statement.property.id !== 'wdt:P725') continue;
      row.label = longCredit.person;
      row.summary.label.value = longCredit.person;
      for (const qualifier of row.statement.qualifiers) {
        if (qualifier.property.id === 'wdt:P1932') {
          qualifier.property.data_type = 'monolingualtext';
          qualifier.value.content = { text: longCredit.name, language: 'ja' };
        }
        const related = row.related[String(qualifier.value.content)];
        if (!related) continue;
        if (qualifier.property.id === 'wdt:P3831') related.label.value = longCredit.role;
        if (qualifier.property.id === 'wdt:P453') related.label.value = longCredit.character;
      }
    }
  }
  return page;
}
