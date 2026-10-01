import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: 'Cette page ne peut pas être affichée pour le moment',
  pageUnavailableBody: 'REZICS n’a pas pu joindre cette fiche. Réessayez dans un instant.',
  notFoundTitle: 'Il n’y a rien ici',
  notFoundBody: 'Aucune ressource n’a cette adresse, ou elle ne vous est pas visible.',
  restricted: 'Privé', restrictedHelp: 'Seules les personnes autorisées peuvent le voir.',

  statements: 'Déclarations', statementsUnavailable: 'Les déclarations n’ont pas pu être chargées.',
  noStatements: 'Aucune déclaration', noStatementsBody: 'Rien n’a encore été accepté à ce sujet.',
  statementsList: 'Déclarations',
  valueSome: 'Valeur inconnue', valueNone: 'Aucune valeur',
  relations: 'Relations', relationsUnavailable: 'Les relations n’ont pas pu être chargées.',
  noRelations: 'Aucune relation', noRelationsBody: 'Rien n’y est encore relié.',
  discussion: 'Discussion',
  startDiscussion: insert('Discuter : {{subject}}', { subject: String }),
  ratingsFor: insert('Notes : {{subject}}', { subject: String }),
  reviewsFor: insert('Critiques : {{subject}}', { subject: String }),
  noRatings: 'Aucune note.',
  unavailable: 'Indisponible', unnamed: 'Sans nom', search: 'Rechercher',
} satisfies EntityPageMessages;
