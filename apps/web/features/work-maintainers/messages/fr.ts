// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: 'Mainteneurs',
  help: 'Les personnes qui peuvent modifier cette œuvre. Toute personne de la liste peut ajouter un mainteneur. Seul le propriétaire peut en retirer un.',
  owner: 'Propriétaire',
  addLabel: 'Ajouter un mainteneur',
  addHelp: 'Son identifiant, par exemple @lin_mei, ou son adresse.',
  add: 'Ajouter',
  remove: 'Retirer',
  removeNamed: insert('Retirer {{name}}', { name: String }),
  confirmTitle: insert('Retirer {{name}} ?', { name: String }),
  confirmBody: insert('{{name}} ne pourra plus modifier cette œuvre. Ce qui est déjà écrit reste.', { name: String }),
  confirm: 'Retirer',
  cancel: 'Annuler',
  saved: 'Liste des mainteneurs mise à jour.',
  savedReplayed: 'Ce changement était déjà enregistré.',
  conflictTitle: 'Cette liste a changé depuis que vous l’avez ouverte',
  conflictBody: 'Rien d’autre n’a été écrit. Rechargez la dernière liste. Ce que vous avez saisi reste ici.',
  reload: 'Recharger la dernière liste',
  continuityTitle: 'Cette œuvre conserve son dernier mainteneur',
  continuityBody: 'Quelqu’un doit pouvoir continuer à la modifier.',
  deniedTitle: 'Vous ne pouvez pas faire ce changement',
  deniedBody: 'Seul le propriétaire peut retirer un mainteneur. N’importe quel mainteneur peut en ajouter un.',
  signInTitle: 'Reconnectez-vous pour changer les mainteneurs',
  invalidTitle: 'Cela n’a pas été accepté',
  unavailableTitle: 'Impossible de changer les mainteneurs',
  unavailableBody: 'Rien n’a été changé. Réessayez dans un instant.',
  loadFailed: 'Impossible de charger les mainteneurs.',
  retry: 'Réessayer',
  loading: 'Chargement des mainteneurs',
  emptyQuery: 'Saisissez un identifiant ou une adresse.',
  badTarget: 'Utilisez un identifiant tel que @lin_mei, ou l’adresse de l’identité.',
  notFound: 'Aucune identité n’utilise cet identifiant.',
  already: insert('{{name}} maintient déjà cette œuvre.', { name: String }),
  self: 'Vous maintenez déjà cette œuvre.',
  mainSays: 'Motif',
};

export default messages;
