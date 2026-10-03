'use client';

import {
  EntityPicker,
  type EntityPickerItem,
  type EntityPickerLoad,
  type EntityPickerSelection,
} from '@rezics/ui/entity-picker';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { discoveryApi, type ConceptChoice } from './api.ts';
import { browseMessages } from './browse-messages.ts';

export interface TopicItem extends EntityPickerItem {
  language?: string;
  direction?: 'ltr' | 'rtl';
  broader?: ConceptChoice['broader'];
  usageCount?: number;
  followed?: boolean;
}
export function topicItem(concept: ConceptChoice): TopicItem {
  return {
    value: concept.id,
    label: concept.name.value,
    language: concept.name.language,
    direction: concept.name.direction,
    broader: concept.broader,
    usageCount: concept.usageCount,
    followed: concept.followed,
  };
}
export function topicLoader(
  locale: UiLocale,
  actingSubject?: string,
  realm?: string,
): EntityPickerLoad<TopicItem> {
  return async ({ q, cursor }) => {
    const page = await discoveryApi(browserMainApi(), locale, actingSubject).concepts({
      q,
      ...(cursor ? { cursor } : {}),
      ...(realm ? { realm } : {}),
    });
    return { ...page, items: page.items.map(topicItem) };
  };
}
/** One indexed, multilingual, traversable Concept picker for every topic-selection surface. */
export function TopicPicker({
  locale,
  value,
  onChange,
  actingSubject,
  realm,
  load,
  max = 8,
  allowExclude = false,
  disabled = false,
}: {
  locale: UiLocale;
  value: EntityPickerSelection<TopicItem>[];
  onChange: (value: EntityPickerSelection<TopicItem>[]) => void;
  actingSubject?: string;
  realm?: string;
  load?: EntityPickerLoad<TopicItem>;
  max?: number;
  allowExclude?: boolean;
  disabled?: boolean;
}) {
  const t = browseMessages[locale];
  const read = load ?? topicLoader(locale, actingSubject, realm);
  return (
    <EntityPicker
      key={`${locale}:${actingSubject ?? ''}:${realm ?? ''}`}
      label={t.topics}
      placeholder={t.topics}
      locale={locale}
      multiple
      allowExclude={allowExclude}
      disabled={disabled}
      value={value}
      load={async (query) => {
        const page = await read(query);
        return {
          ...page,
          items: page.items.map((item) => ({
            ...item,
            disabled:
              item.disabled ||
              (value.length >= max && !value.some((chosen) => chosen.item.value === item.value)),
          })),
        };
      }}
      onValueChange={(next) => {
        if (next.length <= max) onChange(next);
      }}
      renderItem={(item) => (
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <bdi lang={item.language} dir={item.direction} className="truncate">
              {item.label}
            </bdi>
            {item.followed ? (
              <span className="shrink-0 text-muted-foreground text-xs">{t.followed}</span>
            ) : null}
          </span>
          <span className="flex flex-wrap gap-x-2 text-muted-foreground text-xs">
            {item.broader?.map((parent) => (
              <span key={parent.id}>
                {t.broader}{' '}
                <bdi lang={parent.name.language} dir={parent.name.direction}>
                  {parent.name.value}
                </bdi>
              </span>
            ))}
            {item.usageCount !== undefined ? (
              <span>
                {new Intl.NumberFormat(locale).format(item.usageCount)} {t.usage}
              </span>
            ) : null}
          </span>
        </span>
      )}
    />
  );
}
