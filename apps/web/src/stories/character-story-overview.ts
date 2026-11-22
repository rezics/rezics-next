import type { OverviewValue } from '../features/pages/overview';
import type { CharacterPage } from '../features/catalogue/character-reading-port';

export function characterStoryOverview(page: CharacterPage): OverviewValue {
  const labels: OverviewValue['labels'] = {
    spoilerShow: page.spoilerShow,
    documentSpoiler: page.spoilerShow,
    cover: { withheld: '', reveal: '', credit: '', via: '' },
  };
  if (page.labels.spoilerHide !== undefined) labels.spoilerHide = page.labels.spoilerHide;
  const value: OverviewValue = {
    locale: page.locale,
    subject: page.subject,
    link: page.link,
    reader: page.reader,
    labels,
    unlabelled: page.unlabelled,
    spoilerShow: page.spoilerShow,
    details: '',
    cover: '',
    coverVia: '',
    licence: '',
    source: '',
    sources: '',
    sections: new Map(),
    relations: {},
    relationNodes: page.relationNodes ?? [],
  };
  if (page.subjectLabel !== undefined) value.subjectLabel = page.subjectLabel;
  if (page.releaseDigest !== undefined) value.releaseDigest = page.releaseDigest;
  if (page.currentHref !== undefined) value.currentHref = page.currentHref;
  if (page.context !== undefined) value.context = page.context;
  if (page.realm !== undefined) value.realm = page.realm;
  if (page.cacheReader !== undefined) value.cacheReader = page.cacheReader;
  if (page.candidatePropertyLabel !== undefined) value.candidatePropertyLabel = page.candidatePropertyLabel;
  if (page.relationDirections !== undefined) value.relationDirections = page.relationDirections;
  return value;
}
