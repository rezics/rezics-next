import { useMemo, type ReactNode } from 'react';
import {
  WorkReadingProvider,
  workReadingSectionClass,
  type WorkReadingPort,
  type WorkReadingValueProps,
} from '../catalogue/work-reading-port';
import { GameOverview as GameReaderOverview } from '../catalogue/game-reader/entry';
import { MangaReaderEntry as MangaReaderMount } from '../catalogue/manga-reader/entry';
import { CandidateValue } from './scalar-value';
import type { PageLink } from './shared';

function PageWorkValue({ snak, related, locale, link }: WorkReadingValueProps) {
  return <CandidateValue snak={snak} related={related} locale={locale} link={link as PageLink} />;
}

/** Pages adapter: the live CandidateValue surface and the work readers' section rhythm. */
export function createPageWorkReadingPort(): WorkReadingPort {
  return {
    sectionClass: workReadingSectionClass,
    renderValue: (props) => <PageWorkValue {...props} />,
  };
}

export function WorkReadingBinding({ children }: { children: ReactNode }) {
  const port = useMemo(createPageWorkReadingPort, []);
  return <WorkReadingProvider port={port}>{children}</WorkReadingProvider>;
}

export function GameOverview(props: Parameters<typeof GameReaderOverview>[0]) {
  return (
    <WorkReadingBinding>
      <GameReaderOverview {...props} />
    </WorkReadingBinding>
  );
}

export function MangaReaderEntry(props: Parameters<typeof MangaReaderMount>[0]) {
  return (
    <WorkReadingBinding>
      <MangaReaderMount {...props} />
    </WorkReadingBinding>
  );
}
