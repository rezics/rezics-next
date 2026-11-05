/** Pinned Bangumi book families admitted to the local cross-media showcase. */
export type ShowcaseBookFamily = Readonly<{
  id: string;
  seriesId: string;
  seedVolumeIds: readonly string[];
  anime?: Readonly<{ seriesId: string; subjectId: string; relationCode: 1 }>;
  provenance: Readonly<{
    archive: string;
    digest: string;
    citations: readonly string[];
  }>;
}>;

const archive = 'dump-2026-10-20.210332Z.zip';
const digest = '9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93';

export const showcaseBookFamilies: readonly ShowcaseBookFamily[] = [
  {
    id: 'book-girl',
    seriesId: '499',
    seedVolumeIds: ['26'],
    provenance: {
      archive,
      digest,
      citations: ['subject-relations.jsonlines/26/499'],
    },
  },
  {
    id: 'kara-no-kyoukai',
    seriesId: '2815',
    seedVolumeIds: ['5329'],
    anime: { seriesId: '2815', subjectId: '233', relationCode: 1 },
    provenance: {
      archive,
      digest,
      citations: [
        'subject-relations.jsonlines/5329/2815',
        'subject-relations.jsonlines/2815/233',
        'subject-persons.jsonlines/2815/1466/2001',
        'subject-persons.jsonlines/2815/1467/2003',
        'subject-persons.jsonlines/2815/128/2004',
      ],
    },
  },
];

/** The earlier admitted family stays first and keeps its original selection. */
export const showcaseBookFamily = showcaseBookFamilies[0]!;
