import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: 'Diese Seite kann gerade nicht angezeigt werden',
  pageUnavailableBody: 'REZICS konnte diesen Eintrag nicht erreichen. Versuche es gleich noch einmal.',
  notFoundTitle: 'Hier ist nichts',
  notFoundBody: 'Keine Ressource hat diese Adresse, oder sie ist für dich nicht sichtbar.',
  restricted: 'Privat', restrictedHelp: 'Nur Personen mit Zugriff können das sehen.',

  sections: 'Abschnitte',
  statements: 'Aussagen', statementsUnavailable: 'Aussagen konnten nicht geladen werden.',
  noStatements: 'Noch keine Aussagen', noStatementsBody: 'Dazu wurde noch nichts angenommen.',
  statementsList: 'Aussagen',
  valueSome: 'Unbekannter Wert', valueNone: 'Kein Wert',
  relations: 'Beziehungen', relationsUnavailable: 'Beziehungen konnten nicht geladen werden.',
  noRelations: 'Noch keine Beziehungen', noRelationsBody: 'Damit ist noch nichts verbunden.',
  relationsSignIn: 'Melde dich an, um zu sehen, womit das verbunden ist.',
  relationsIdentity: 'Wähle eine Identität, um zu sehen, womit das verbunden ist.',
  discussion: 'Diskussion',
  startDiscussion: insert('Diskutieren: {{subject}}', { subject: String }),
  ratingsFor: insert('Bewertungen – {{subject}}', { subject: String }),
  reviewsFor: insert('Rezensionen – {{subject}}', { subject: String }),
  ratingsReadOnly: 'Bewerten und Rezensieren ist hier noch nicht möglich.',
  noRatings: 'Noch keine Bewertungen.',
  unavailable: 'Nicht verfügbar', unnamed: 'Ohne Namen', search: 'Suche',
} satisfies EntityPageMessages;
