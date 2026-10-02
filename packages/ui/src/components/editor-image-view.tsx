'use client';

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { ImageSettings, type ImageLabelEditor } from './image-settings.tsx';
import { MediaImage, useMediaImageMetadata } from './media-image.tsx';
export type { ImageLabelEditor } from './image-settings.tsx';

/** Image settings live beside the selected occurrence, keeping labels and author concealment separate. */
export function EditorImageView({ node, selected, editor, updateAttributes, extension, getPos }: NodeViewProps) {
  const reference = typeof node.attrs.representationId === 'string' ? { representationId: node.attrs.representationId,
    mediaUseId: typeof node.attrs.mediaUseId === 'string' ? node.attrs.mediaUseId : undefined } : undefined;
  const { metadata, updateMetadata } = useMediaImageMetadata(reference);
  const edit = extension.options.onEditImageLabels as ImageLabelEditor | undefined;
  const conceal = metadata?.mediaUseId ? Boolean(metadata.conceal) : Boolean(node.attrs.conceal || metadata?.conceal);
  return <NodeViewWrapper as="figure" data-block-id={node.attrs.id}
    onMouseDown={(event: React.MouseEvent<HTMLElement>) => {
      if (!editor.isEditable || (event.target as HTMLElement).closest('button,input,select,[data-slot="image-settings"]')) return;
      const position = getPos();
      if (typeof position === 'number') { event.preventDefault(); editor.chain().focus().setNodeSelection(position).run(); }
    }}>
    <MediaImage src={node.attrs.src} alt={node.attrs.alt ?? ''} title={node.attrs.title ?? undefined}
      representationId={reference?.representationId} mediaUseId={reference?.mediaUseId} conceal={conceal}
      width={node.attrs.width ?? undefined} height={node.attrs.height ?? undefined} />
    {selected && editor.isEditable ? <ImageSettings metadata={metadata ?? undefined} onEditImageLabels={edit} conceal={conceal}
      localConceal={!reference} onMetadataChange={updateMetadata} onConcealChange={value => updateAttributes({ conceal: value })} /> : null}
  </NodeViewWrapper>;
}
