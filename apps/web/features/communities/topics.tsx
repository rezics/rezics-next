'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { TopicPicker as ConceptPicker } from '../discover/topic-picker.tsx';

export interface TopicChoice {
  id: string;
  label: string;
}
/** Community creation uses the same indexed Concept chooser as Discover. */
export function TopicPicker({
  locale,
  value,
  onChange,
  max = 3,
}: {
  locale: UiLocale;
  value: TopicChoice[];
  onChange: (topics: TopicChoice[]) => void;
  max?: number;
}) {
  return (
    <ConceptPicker
      locale={locale}
      max={max}
      value={value.map((topic) => ({ item: { value: topic.id, label: topic.label } }))}
      onChange={(next) => onChange(next.map(({ item }) => ({ id: item.value, label: item.label })))}
    />
  );
}
