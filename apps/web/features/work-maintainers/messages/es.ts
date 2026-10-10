// Machine-drafted; needs native review.
import { insert } from 'native-i18n';
import type { WorkMaintainerMessages } from '../messages.ts';

const messages: WorkMaintainerMessages = {
  heading: 'Mantenedores',
  help: 'Personas que pueden editar esta obra. Cualquiera de la lista puede añadir un mantenedor. Solo el propietario puede quitar a uno.',
  owner: 'Propietario',
  addLabel: 'Añadir un mantenedor',
  addHelp: 'Su identificador, por ejemplo @lin_mei, o su dirección.',
  add: 'Añadir',
  remove: 'Quitar',
  removeNamed: insert('Quitar a {{name}}', { name: String }),
  confirmTitle: insert('¿Quitar a {{name}}?', { name: String }),
  confirmBody: insert('{{name}} ya no podrá editar esta obra. Lo que ya escribió se conserva.', { name: String }),
  confirm: 'Quitar',
  cancel: 'Cancelar',
  saved: 'Lista de mantenedores actualizada.',
  savedReplayed: 'Este cambio ya estaba registrado.',
  conflictTitle: 'Esta lista cambió desde que la abriste',
  conflictBody: 'No se escribió nada más. Recarga la lista más reciente. Lo que escribiste sigue aquí.',
  reload: 'Recargar la lista más reciente',
  continuityTitle: 'Esta obra conserva a su último mantenedor',
  continuityBody: 'Alguien tiene que poder seguir editándola.',
  deniedTitle: 'No puedes hacer este cambio',
  deniedBody: 'Solo el propietario puede quitar a un mantenedor. Cualquier mantenedor puede añadir a uno.',
  signInTitle: 'Vuelve a entrar para cambiar los mantenedores',
  invalidTitle: 'Eso no se aceptó',
  unavailableTitle: 'No se pudieron cambiar los mantenedores',
  unavailableBody: 'No se cambió nada. Inténtalo de nuevo en un momento.',
  loadFailed: 'No se pudieron cargar los mantenedores.',
  retry: 'Reintentar',
  loading: 'Cargando mantenedores',
  emptyQuery: 'Escribe un identificador o una dirección.',
  badTarget: 'Usa un identificador como @lin_mei, o la dirección de la identidad.',
  notFound: 'Ninguna identidad usa ese identificador.',
  already: insert('{{name}} ya mantiene esta obra.', { name: String }),
  self: 'Ya mantienes esta obra.',
  mainSays: 'Motivo',
};

export default messages;
