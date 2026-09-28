import { asValue, insert, number, plural } from 'native-i18n';
import type { HomeMessages } from '../messages.ts';

export default {
  title: 'Inicio',

  // Continue
  continueTitle: 'Seguir leyendo',
  newChapters: plural({ one: insert('{{count}} nuevo'), other: insert('{{count}} nuevos') }, { count: asValue(number()) }),
  newChaptersAtLeast: plural({ one: insert('{{count}}+ nuevo'), other: insert('{{count}}+ nuevos') },
    { count: asValue(number()) }),
  nextChapter: insert('Siguiente: {{chapter}}', { chapter: String }), nextUp: 'Retoma donde lo dejaste',
  continueWork: insert('Seguir con «{{title}}»', { title: String }),
  hideFromContinue: insert('Ocultar «{{title}}» de Seguir leyendo', { title: String }),
  hiddenFromContinue: insert('«{{title}}» ya no aparece en Seguir leyendo.', { title: String }),
  hideFailed: 'No se pudo ocultar la obra. Inténtalo de nuevo.', undo: 'Deshacer',
  scrollBack: 'Desplazarse hacia atrás', scrollForward: 'Desplazarse hacia delante',

  // Signed out
  welcomeTitle: 'Sigue comunidades para personalizar tu inicio',
  welcomeBody: 'Únete a las comunidades de las obras que te gustan. Aquí aparecerán sus nuevos capítulos, selecciones y conversaciones.',
  signUp: 'Únete a REZICS', signIn: 'Iniciar sesión', dismiss: 'Descartar',
  officialZones: 'Zones oficiales', officialZonesIntro: 'Selecciones de las comunidades de REZICS',

  // Suggestions
  reasonPopular: 'Popular en REZICS',
  members: plural({ one: insert('{{count}} miembro'), other: insert('{{count}} miembros') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('Aproximadamente {{count}} miembro'), other: insert('Aproximadamente {{count}} miembros') },
    { count: asValue(number()) }),

  // The rail
  sidebar: 'Más de REZICS',
  trendingFollowed: 'Tendencias en tus comunidades', trendingGlobal: 'Tendencias de esta semana',
  trendingEmpty: 'Esta semana aún no hay tendencias.',
  realmsToFollow: 'Comunidades para seguir', popularRealms: 'Comunidades populares',
  follow: 'Seguir', followed: 'Siguiendo', followRealm: insert('Seguir {{realm}}', { realm: String }),
  followOneFailed: 'No se pudo seguir la comunidad. Inténtalo de nuevo.',
  queueTitle: 'Tu cola de moderación',
  queueWaiting: insert('{{count}} en espera', { count: String }), queueClear: 'No hay nada en espera',
  openManage: 'Abrir administración',
  howHomeWorks: 'Cómo funciona Inicio',
  howBest: insert('Mejores ordena las publicaciones según los votos de los lectores, que pierden peso durante unas {{hours}} horas. Compara cada publicación con otras de su comunidad.',
    { hours: String }),
  howCap: insert('Ninguna comunidad puede ocupar más de {{cap}} puestos seguidos entre {{window}} publicaciones.', { cap: String, window: String }),
  howNew: 'Nuevas muestra primero lo más reciente. Destacadas cuenta los votos del periodo que elijas.',
  howFollowing: 'Siguiendo muestra las comunidades, Zones y obras que sigues. Solo aparecen sugerencias cuando hay poca actividad, y se identifican como tales.',
} satisfies Partial<HomeMessages>;
