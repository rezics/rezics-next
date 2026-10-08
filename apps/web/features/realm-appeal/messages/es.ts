// Machine-drafted; needs native review.
import { insert } from 'native-i18n';

export default {
  region: 'Tu expulsión',
  title: 'Te han expulsado de esta comunidad',
  endedTitle: 'Esta expulsión ya terminó',
  permanent: 'Esta expulsión no tiene fin.',
  until: insert('Esta expulsión termina el {{date}}.', { date: String }),
  ended: insert('Esta expulsión terminó el {{date}}.', { date: String }),
  recorded: insert('Expulsión el {{date}}.', { date: String }),
  reasonLabel: 'Motivo registrado',
  appealTitle: 'Apelar esta expulsión',
  appealHelp: 'Puedes apelar una sola vez. Escribe qué deberían reconsiderar quienes moderan.',
  statementLabel: 'Tu mensaje',
  statementHint: 'Hasta 2.000 caracteres.',
  send: 'Enviar apelación',
  statementEmpty: 'Escribe qué deberían reconsiderar.',
  statementLong: 'Usa 2.000 caracteres o menos.',
  sendFailed: 'La apelación no se envió. Tu mensaje sigue aquí.',
  receivedTitle: 'Apelación recibida',
  receivedBody: 'Quienes moderan tienen tu mensaje. Esta expulsión no admite una segunda apelación.',
  statementHeading: 'Lo que enviaste',
  upheld: insert('Quienes moderan confirmaron la expulsión el {{date}}.', { date: String }),
  upheldUndated: 'Quienes moderan confirmaron la expulsión.',
  lifted: insert('Tu expulsión se levantó el {{date}}.', { date: String }),
  liftedUndated: 'Tu expulsión se levantó.',
  sharedLabel: 'Lo que compartieron',
};
