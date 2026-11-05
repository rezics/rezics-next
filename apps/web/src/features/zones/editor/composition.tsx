import { Puck } from '@puckeditor/core';
import { platformRegistry, type CompositionDocument } from '@rezics/composition';
import { useMemo, useState } from 'react';
import { editorConfiguration } from '../../pages/editor';
import { fromComposition, toComposition, type PageEditorData } from '../../pages/editor-config';

/** The COMMON editor configuration, with Zone Save/visibility controls supplied by the resource form. */
export default function CompositionEditor({
  document,
  locale,
  onChange,
}: {
  document: CompositionDocument;
  locale: string;
  onChange(document: CompositionDocument): void;
}) {
  const config = useMemo(() => editorConfiguration(platformRegistry, locale), [locale]);
  const [data] = useState(() => fromComposition(document));
  return (
    <Puck
      config={config}
      data={data}
      onChange={(edited) => onChange(toComposition(edited as PageEditorData))}
      overrides={{ headerActions: () => <></> }}
    />
  );
}
