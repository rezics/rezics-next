import { insert } from 'native-i18n';
import type { EntityPageMessages } from '../messages.ts';

export default {
  pageUnavailableTitle: 'Esta página no se puede mostrar ahora',
  pageUnavailableBody: 'REZICS no pudo acceder a este registro. Inténtalo de nuevo en un momento.',
  notFoundTitle: 'Aquí no hay nada',
  notFoundBody: 'Ningún recurso tiene esta dirección, o no es visible para ti.',
  restricted: 'Privado', restrictedHelp: 'Solo pueden verlo las personas con acceso.',

  statements: 'Afirmaciones', statementsUnavailable: 'No se pudieron cargar las afirmaciones.',
  noStatements: 'Aún no hay afirmaciones', noStatementsBody: 'Todavía no se ha aceptado nada sobre esto.',
  statementsList: 'Afirmaciones',
  valueSome: 'Valor desconocido', valueNone: 'Sin valor',
  relations: 'Relaciones', relationsUnavailable: 'No se pudieron cargar las relaciones.',
  noRelations: 'Aún no hay relaciones', noRelationsBody: 'Todavía no hay nada relacionado con esto.',
  discussion: 'Debate',
  startDiscussion: insert('Debatir: {{subject}}', { subject: String }),
  ratingsFor: insert('Valoraciones: {{subject}}', { subject: String }),
  reviewsFor: insert('Reseñas: {{subject}}', { subject: String }),
  noRatings: 'Aún no hay valoraciones.',
  unavailable: 'No disponible', unnamed: 'Sin nombre', search: 'Buscar',
} satisfies EntityPageMessages;
