/** Native type replacement policy, independent of homepage interests. A type
 * without a reviewed combination is admitted on its own. Generic Works need none. */
const compatibleTypeSets: readonly (readonly string[])[] = [
  ['https://schema.org/Book', 'https://schema.org/BookSeries'],
  ['https://schema.org/SoftwareApplication', 'https://schema.org/SoftwareSourceCode', 'https://rezics.com/vocab/ModPackage'],
  ['https://schema.org/VideoGame', 'https://schema.org/Movie', 'https://schema.org/TVSeries', 'https://schema.org/VideoObject',
    'https://schema.org/AudioObject', 'https://schema.org/MusicRecording', 'https://schema.org/MusicAlbum'],
];

export function nativeWorkTypesCompatible(types: readonly string[]): boolean {
  const specific = types.filter(type => type !== 'https://schema.org/DigitalDocument');
  return specific.length <= 1 || compatibleTypeSets.some(set => specific.every(type => set.includes(type)));
}
