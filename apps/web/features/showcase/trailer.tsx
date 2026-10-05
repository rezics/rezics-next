'use client';

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@rezics/ui/dialog';
import { PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { trailerEmbed } from './stage.ts';

export function Trailer({ href, label, title }: { href: string; label: string; title: string }) {
  const [open, setOpen] = useState(false);
  const embed = trailerEmbed(href);
  let external: URL;
  try {
    external = new URL(href);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(external.protocol)) return null;
  if (!embed)
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="showcase-action showcase-secondary"
      >
        <PlayIcon aria-hidden="true" />
        {label}
      </a>
    );
  return (
    <Dialog open={open} onOpenChange={(details) => setOpen(details.open)}>
      <DialogTrigger className="showcase-action showcase-secondary">
        <PlayIcon aria-hidden="true" />
        {label}
      </DialogTrigger>
      <DialogContent size="lg" bottomStickOnMobile={false} className="p-4 pt-12">
        <DialogTitle>{title}</DialogTitle>
        {open ? (
          <iframe
            title={`${label}: ${title}`}
            src={embed}
            className="aspect-video w-full rounded-lg border-0"
            allow="fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
