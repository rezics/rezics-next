// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: 'Votre bannissement',
  title: 'Vous êtes banni·e de cette communauté',
  endedTitle: 'Ce bannissement est terminé',
  permanent: 'Ce bannissement n’a pas de fin.',
  until: insert('Ce bannissement prend fin le {{date}}.', { date: String }),
  ended: insert('Ce bannissement a pris fin le {{date}}.', { date: String }),
  recorded: insert('Banni·e le {{date}}.', { date: String }),
  reasonLabel: 'Motif indiqué',
  appealTitle: 'Faire appel de ce bannissement',
  appealHelp: 'Vous ne pouvez faire appel qu’une fois. Écrivez ce que les modérateurs doivent reconsidérer.',
  statementLabel: 'Votre message',
  statementHint: '2 000 caractères au plus.',
  send: 'Envoyer l’appel',
  statementEmpty: 'Écrivez ce qu’il faut reconsidérer.',
  statementLong: 'Restez dans la limite de 2 000 caractères.',
  sendFailed: 'L’appel n’a pas été envoyé. Votre message est toujours là.',
  receivedTitle: 'Appel reçu',
  receivedBody: 'Les modérateurs ont votre message. Ce bannissement n’accepte pas un second appel.',
  statementHeading: 'Ce que vous avez envoyé',
  upheld: insert('Les modérateurs ont maintenu le bannissement le {{date}}.', { date: String }),
  upheldUndated: 'Les modérateurs ont maintenu le bannissement.',
  lifted: insert('Votre bannissement a été levé le {{date}}.', { date: String }),
  liftedUndated: 'Votre bannissement a été levé.',
  sharedLabel: 'Ce qu’ils ont partagé',
};
