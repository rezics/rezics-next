import { DATASET, iri, lit, prepareComponent, prepareWorkComponent,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const CONTINUITY = 'https://rezics.com/definition/continuity/native-work-v1';
const PROFILE = 'https://rezics.com/definition/work-metadata-v1';

export interface LegacyStudioChapter {
  work: string; mainVersion: string; workRevision: string; mainRevision: string;
  book: string; title: string; language: string; operation: string; sequence: string;
}

/** Freeze the pre-Post Studio command's complete graph footprint, including
 * both component heads and immutable anchors, so retirement sees real data. */
export async function legacyStudioChapter(env: WorkActivationEnvironment, chapter: LegacyStudioChapter) {
  const chapterWorkManifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, chapter.work, { mainVersion: chapter.mainVersion,
      continuityProfile: CONTINUITY, title: chapter.title, language: chapter.language,
      parentWork: chapter.book }, PROFILE)
    : prepareComponent(env.objectDirectory, chapter.work, { mainVersion: chapter.mainVersion,
      continuityProfile: CONTINUITY, title: chapter.title, language: chapter.language,
      parentWork: chapter.book }, PROFILE);
  const chapterMainManifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, chapter.mainVersion,
      { work: chapter.work, hostingPolicy: 'metadata-only' }, PROFILE)
    : prepareComponent(env.objectDirectory, chapter.mainVersion,
      { work: chapter.work, hostingPolicy: 'metadata-only' }, PROFILE);
  return {
    current: `${iri(chapter.work)} a schema:CreativeWork ;
      rv:mainVersion ${iri(chapter.mainVersion)} ; rv:continuityProfile ${iri(CONTINUITY)} ;
      schema:isPartOf ${iri(chapter.book)} ; rdfs:label ${lit(chapter.title)}@${chapter.language} ;
      rv:head ${iri(chapter.workRevision)} .
      ${iri(chapter.mainVersion)} a rv:MainVersion ; rv:work ${iri(chapter.work)} ;
      rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(chapter.mainRevision)} .`,
    revisions: `${iri(chapter.workRevision)} a rv:RevisionAnchor ;
      rv:component ${iri(chapter.work)} ; rv:operation ${iri(chapter.operation)} ;
      rv:manifest ${iri(`urn:rezics:sha256:${chapterWorkManifest}`)} ;
      rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ${chapter.sequence} .
      ${iri(chapter.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(chapter.mainVersion)} ;
      rv:operation ${iri(chapter.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${chapterMainManifest}`)} ;
      rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ${chapter.sequence} .`,
  };
}
