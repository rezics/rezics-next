// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: 'Betreuende',
  help: 'Personen, die dieses Werk bearbeiten können. Wer in der Liste steht, kann jemanden hinzufügen. Nur der Eigentümer kann jemanden entfernen.',
  owner: 'Eigentümer',
  addLabel: 'Betreuende Person hinzufügen',
  addHelp: 'Ihr Handle, zum Beispiel @lin_mei, oder ihre Adresse.',
  add: 'Hinzufügen',
  remove: 'Entfernen',
  removeNamed: insert('{{name}} entfernen', { name: String }),
  confirmTitle: insert('{{name}} entfernen?', { name: String }),
  confirmBody: insert('{{name}} kann dieses Werk dann nicht mehr bearbeiten. Was bereits geschrieben ist, bleibt.', { name: String }),
  confirm: 'Entfernen',
  cancel: 'Abbrechen',
  saved: 'Liste der Betreuenden aktualisiert.',
  savedReplayed: 'Diese Änderung war bereits festgehalten.',
  conflictTitle: 'Diese Liste hat sich geändert, seit du sie geöffnet hast',
  conflictBody: 'Es wurde nichts Weiteres geschrieben. Lade die neueste Liste. Was du eingegeben hast, bleibt hier.',
  reload: 'Neueste Liste laden',
  continuityTitle: 'Dieses Werk behält seine letzte betreuende Person',
  continuityBody: 'Jemand muss es weiter bearbeiten können.',
  deniedTitle: 'Du kannst diese Änderung nicht vornehmen',
  deniedBody: 'Nur der Eigentümer kann eine betreuende Person entfernen. Hinzufügen kann jede betreuende Person.',
  signInTitle: 'Melde dich erneut an, um Betreuende zu ändern',
  invalidTitle: 'Das wurde nicht angenommen',
  unavailableTitle: 'Betreuende konnten nicht geändert werden',
  unavailableBody: 'Es wurde nichts geändert. Versuche es gleich noch einmal.',
  loadFailed: 'Betreuende konnten nicht geladen werden.',
  retry: 'Erneut versuchen',
  loading: 'Betreuende werden geladen',
  emptyQuery: 'Gib ein Handle oder eine Adresse ein.',
  badTarget: 'Verwende ein Handle wie @lin_mei oder die Adresse der Identität.',
  notFound: 'Keine Identität verwendet dieses Handle.',
  already: insert('{{name}} betreut dieses Werk bereits.', { name: String }),
  self: 'Du betreust dieses Werk bereits.',
  mainSays: 'Grund',
};

export default messages;
