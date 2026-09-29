import { Badge } from '@rezics/ui/badge';
import { Users } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';

const rules = [
  { lang: 'en', text: 'Mark spoilers until a volume is a month old.' },
  { lang: 'zh-Hant', text: '新書出版一個月內，請標註劇透。' },
  { lang: 'ja', text: '刊行から一か月はネタバレを明記してください。' },
] as const;

/** A Realm's front page: name, members, languages and rules stated once in each language. */
export function RealmCard({ words }: { words: IllustrationCopy }) {
  return (
    <Plate className="aura-surface overflow-hidden">
      <div className="flex items-center justify-between gap-4">
        <h3 lang="en" className="text-xl font-bold">
          Salt Marsh Readers
        </h3>
        <Badge variant="outline">
          <Users aria-hidden />
          {fill(words.members, '2,418')}
        </Badge>
      </div>
      <p className="mt-4 text-sm font-semibold">{words.rules}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {rules.map((rule) => (
          <li
            key={rule.lang}
            lang={rule.lang}
            className="rounded-xl bg-background/80 px-3 py-2 text-sm"
          >
            {rule.text}
          </li>
        ))}
      </ul>
    </Plate>
  );
}
