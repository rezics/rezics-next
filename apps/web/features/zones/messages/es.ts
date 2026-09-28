import { asValue, insert, number, plural } from 'native-i18n';
import type { ZoneMessages } from '../messages.ts';

export default {
  more: 'Ver más', shuffle: 'Mezclar',
  whyHere: insert('Por qué está aquí «{{title}}»', { title: String }),
  untitled: 'Obra sin título',
  rank: insert('n.º {{rank}}', { rank: String }),
  day: 'Hoy', week: 'Esta semana', month: 'Este mes', completed: 'Terminadas',
  newChapter: insert('Capítulo nuevo: {{chapter}}', { chapter: String }),
  heroLabel: 'Destacados', previous: 'Anterior', next: 'Siguiente',
  slide: insert('{{index}} de {{count}}', { index: String, count: String }),
  read: 'Empezar a leer', readWork: 'Ver la obra',
  dismiss: 'Descartar', announcement: 'Anuncio',
  adopted: insert('Obra añadida: «{{title}}»', { title: String }), adoptedUnknown: 'Obra añadida',
  classified: insert('Clasificación de «{{title}}»', { title: String }), classifiedUnknown: 'Clasificación de una obra',
  classificationRejected: insert('Clasificación rechazada para «{{title}}»', { title: String }),
  classificationRejectedUnknown: 'Clasificación rechazada',
  ruleChanged: 'Regla de la comunidad modificada',
  quoteBy: insert('Cita de {{reader}}', { reader: String }),
  replies: plural({ one: insert('{{count}} respuesta'), other: insert('{{count}} respuestas') },
    { count: asValue(number()) }),
  failed: insert('No se pudo cargar {{module}}', { module: String }), retry: 'Reintentar',
  lookLabel: 'Estilo de página', lookZone: 'Diseño de la comunidad', lookStandard: 'Diseño estándar',
  lookHelp: 'El diseño estándar se aplica a todas las comunidades.',
  lookSaveFailed: 'No se pudo guardar el estilo de página. Inténtalo de nuevo.',
  safeModeTitle: 'Se muestra el diseño estándar de esta comunidad',
  safeModeBody: 'El diseño personalizado de esta comunidad está desactivado en esta página, así que aquí todo se muestra con los componentes de la plataforma.',
  showDesign: 'Mostrar el diseño completo',
  // The default layout's module titles.
  picks: 'Destacados', genres: 'Géneros', latest: 'Novedades', newChapters: 'Capítulos nuevos',
  newlyAdded: 'Nuevas incorporaciones', recentlyCompleted: 'Obras terminadas', rankings: 'Clasificaciones',
  quotes: 'Citas recientes', rising: 'En ascenso', decisions: 'Decisiones recientes',
} satisfies Partial<ZoneMessages>;
