import { statementFixture, type StatementScenario } from './catalogue-statements';
import { proposeFact, type FactsTransport } from '../../features/catalogue/subject-facts';

/** Two existing native-shaped slot fixtures; no alternate proposal or review engine. */
export function subjectFactsFixture(scenario: StatementScenario | 'partial' = 'ready', locale = 'en') {
  const date = statementFixture(scenario === 'partial' ? 'ready' : scenario, locale);
  const language = statementFixture(scenario === 'partial' ? 'denied' : scenario, locale, 'schema:inLanguage');
  language.candidate.id = `${date.id.slice(0, -3)}989`;
  language.candidate.statement.id = language.candidate.id;
  language.candidate.decision = null;
  language.candidate.head = null;
  const slots = [date, language];
  const transport: FactsTransport = {
    read: async () => {
      const current = await date.editor.read();
      if (current.ok)
        current.public.subject.statements['schema:inLanguage'] = structuredClone(
          language.publicRead.subject.statements['schema:inLanguage'] ?? [],
        );
      return current;
    },
    propose: (command) => {
      const slot = slots.find((slot) => slot.address.property === command.statement.property.id) ?? date;
      return proposeFact(slot.client, 'Bearer fixture', command);
    },
  };
  return {
    date,
    language,
    transport,
    review: (property: string) => (property === language.address.property ? language : date).review,
  };
}
