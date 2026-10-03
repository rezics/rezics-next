import type { EntityPickerItem, EntityPickerPage } from '@rezics/ui/entity-picker';
import type { ZoneText } from '@rezics/zone-sdk';
import type { MainClient } from '../discover/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { idOf } from '../work-page/route.ts';
import { withPosition } from './position.ts';

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }>
  ? NonNullable<Data>
  : never;
export type ReadingPositionPage = Ok<ReturnType<MainClient['v1']['reading-positions']>['get']>;
export type ReadingPositionItem = ReadingPositionPage['items'][number];
export interface PositionPickerItem extends EntityPickerItem {
  href: string;
  text: ZoneText;
  current: boolean;
}
export class PositionReadError extends Error {
  constructor(readonly status: number) {
    super('Reading positions unavailable');
  }
}

/** The content's own language survives interface-language selection. */
export function pickPositionLabel(
  labels: readonly { value: string; language: string }[] | undefined,
  locale: string,
): ZoneText | null {
  if (!labels?.length) return null;
  const base = (tag: string) => tag.split('-')[0]!.toLowerCase();
  const chosen =
    labels.find((label) => label.language === locale) ??
    labels.find((label) => base(label.language) === base(locale)) ??
    labels.find((label) => base(label.language) === 'en') ??
    labels[0]!;
  return zoneContentText(chosen.value, chosen.language);
}

/** Main searches every carried language and applies disclosure before the page bound. */
export async function readReadingPositionPage(
  main: MainClient,
  input: {
    work: string;
    position?: string;
    actingSubject?: string;
    q?: string;
    cursor?: string;
    limit?: number;
    language?: string;
  },
): Promise<ReadingPositionPage> {
  const { work, ...query } = input;
  const read = () =>
    main.v1['reading-positions']({ work: work.slice(-36) }).get({
      query: {
        ...query,
        limit: input.limit ?? 50,
      },
    });
  let answer = await read();
  if (answer.error?.status === 409 && !input.cursor) answer = await read();
  if (answer.error || !answer.data) throw new PositionReadError(answer.error?.status ?? 503);
  const page = answer.data;
  if (
    (!page.complete && (!page.nextCursor || page.nextCursor === input.cursor)) ||
    (page.complete && page.nextCursor !== null)
  )
    throw new PositionReadError(503);
  return page;
}

/** No labels or local filtering are loaded after pagination; a hidden name stays hidden. */
export function positionPickerPage(
  page: Pick<ReadingPositionPage, 'items' | 'nextCursor' | 'complete'>,
  here: string,
  locale: string,
  current: string | null,
): EntityPickerPage<PositionPickerItem> {
  return {
    nextCursor: page.nextCursor,
    complete: page.complete,
    items: page.items.map((item) => {
      const value = idOf(item.occurrence);
      if (!value) throw new PositionReadError(503);
      const text =
        pickPositionLabel(item.labels, locale) ??
        zoneContentText(
          item.displayLabel ?? (item.ordinal ? String(item.ordinal) : value.slice(0, 8)),
        );
      return {
        value,
        label: text.value,
        text,
        current: value === current,
        href: withPosition(here, { kind: 'at', occurrence: value }),
      };
    }),
  };
}
