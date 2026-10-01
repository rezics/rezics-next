import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: 'Diese Seite kann gerade nicht angezeigt werden',
  pageUnavailableBody: 'REZICS konnte diesen Eintrag nicht erreichen. Versuche es gleich noch einmal.',
  notFoundTitle: 'Hier ist nichts',
  notFoundBody: 'Keine Ressource hat diese Adresse, oder sie ist für dich nicht sichtbar.',
  restricted: 'Privat', restrictedHelp: 'Nur Personen mit Zugriff können das sehen.',

  statements: 'Aussagen', statementsUnavailable: 'Aussagen konnten nicht geladen werden.',
  noStatements: 'Noch keine Aussagen', noStatementsBody: 'Dazu wurde noch nichts angenommen.',
  statementsList: 'Aussagen',
  valueSome: 'Unbekannter Wert', valueNone: 'Kein Wert',
  relations: 'Beziehungen', relationsUnavailable: 'Beziehungen konnten nicht geladen werden.',
  noRelations: 'Noch keine Beziehungen', noRelationsBody: 'Damit ist noch nichts verbunden.',
  discussion: 'Diskussion',
  startDiscussion: insert('Diskutieren: {{subject}}', { subject: String }),
  ratingsFor: insert('Bewertungen – {{subject}}', { subject: String }),
  reviewsFor: insert('Rezensionen – {{subject}}', { subject: String }),
  noRatings: 'Noch keine Bewertungen.',
  unavailable: 'Nicht verfügbar', unnamed: 'Ohne Namen', search: 'Suche',
} satisfies EntityPageMessages;
