import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { Bot, ShieldCheck, UserCheck } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { lantern } from './sample.ts';

/** A work with the labels that travel with it: suitability, AI declaration, review and rights. */
export function LabelledWork({ words }: { words: IllustrationCopy }) {
  return (
    <Plate className="flex gap-5">
      <WorkCover
        kind="book"
        id={lantern.editions[1].id}
        title={lantern.editions[1].title}
        lang="zh-Hant"
        authors={['佐藤美拉']}
        className="w-28 shrink-0 self-start rounded-md sm:w-36"
      />
      <ul className="flex min-w-0 flex-col items-start gap-2.5">
        <li>
          <Badge
            variant="success"
            size="lg"
            className="h-auto min-h-7 whitespace-normal py-1 text-start"
          >
            <ShieldCheck aria-hidden />
            {words.general}
          </Badge>
        </li>
        <li>
          <Badge
            variant="info"
            size="lg"
            className="h-auto min-h-7 whitespace-normal py-1 text-start"
          >
            <Bot aria-hidden />
            {words.aiAssisted}
          </Badge>
        </li>
        <li>
          <Badge
            variant="success"
            size="lg"
            className="h-auto min-h-7 whitespace-normal py-1 text-start"
          >
            <UserCheck aria-hidden />
            {words.humanReviewed}
          </Badge>
        </li>
        <li className="ps-1 pt-1 text-sm text-muted-foreground">
          {words.rights}: {words.rightsHeld}
        </li>
      </ul>
    </Plate>
  );
}
