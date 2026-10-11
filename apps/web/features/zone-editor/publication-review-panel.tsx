import { Button } from '@rezics/ui/button';
import type { ZoneEditorMessages } from './messages.ts';
import type { SavedPublicationSelection } from './publication-review.ts';

export function PublicationReviewPanel({ selection, copy, busy, onPublish }: {
  selection: SavedPublicationSelection;
  copy: ZoneEditorMessages;
  busy: boolean;
  onPublish(): void;
}) {
  const hasNavigation = selection.presentationNavigation.length > 0 || selection.navigation.length > 0;
  return <section className="grid min-w-0 gap-3 rounded-md border border-border/70 p-3"
    aria-labelledby="zone-publish-review-title">
    <div className="space-y-1">
      <h3 id="zone-publish-review-title" className="font-medium text-sm">{copy.publishReviewTitle}</h3>
      <p className="text-muted-foreground text-sm">{copy.publishReviewBody}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <h4 className="font-medium text-sm">{copy.publishReviewNavigation}</h4>
        {hasNavigation ? <ul className="grid gap-1 text-sm">
          {selection.presentationNavigation.map((link, index) => <li key={`presentation-${index}`} className="break-words">
            {link.label} <span className="text-muted-foreground">({link.href})</span>
          </li>)}
          {selection.navigation.map(link => <li key={link.id} className="break-words">
            {link.name} <span className="text-muted-foreground">(/{link.segment})</span>
          </li>)}
        </ul> : <p className="text-muted-foreground text-sm">{copy.publishReviewNoNavigation}</p>}
      </div>
      <div className="min-w-0 space-y-1">
        <h4 className="font-medium text-sm">{copy.publishReviewTheme}</h4>
        <ul className="grid gap-1 text-sm">
          <li>{copy.themeDensity}: {selection.theme.density === 'compact' ? copy.themeCompact : copy.themeComfortable}</li>
          <li>{copy.themePageSurface}: {selection.theme.pageSurface === 'cards' ? copy.themeCards : copy.themeFlat}</li>
        </ul>
      </div>
    </div>
    <Button variant="outline" size="sm" className="justify-self-start" disabled={busy} onClick={onPublish}>
      {copy.publishReviewed}
    </Button>
  </section>;
}
