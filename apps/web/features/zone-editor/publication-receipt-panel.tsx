import type { ZoneEditorMessages } from './messages.ts';
import type { PublicationReceipt } from './model.ts';

/** Keep the acknowledged cut inspectable after another publisher advances the live site. */
export function PublicationReceiptPanel({ receipt, copy }: { receipt: PublicationReceipt; copy: ZoneEditorMessages }) {
  return <details className="min-w-0 rounded-md border border-border/70 p-3 text-sm">
    <summary className="cursor-pointer font-medium">{copy.receiptTitle}</summary>
    <div className="mt-3 grid min-w-0 gap-3">
      <p className="text-pretty text-muted-foreground">{copy.receiptBody}</p>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
        <Cut label={copy.receiptTitle} value={receipt.revision} />
        <Cut label={copy.sectionHome} value={receipt.homeRevision} />
        <Cut label={copy.sectionNavigation} value={receipt.navigationRevision} />
        <Cut label={copy.sectionTheme} value={receipt.themeRevision} />
      </dl>
      <h3 className="font-medium">{copy.receiptPages} ({receipt.pages.length})</h3>
      <ul className="grid min-w-0 gap-3">
        {receipt.pages.map(page => <li key={`${page.page}/${page.variantId}`} className="grid min-w-0 gap-1">
          <span className="break-all">{page.page}</span>
          <code className="break-all text-xs">{page.variantId}</code>
          <code className="break-all text-xs">{page.revisionId}</code>
          <code className="break-all text-xs">{page.byteDigest}</code>
          <span lang={page.language === 'und' ? undefined : page.language}>{page.language}</span>
        </li>)}
      </ul>
    </div>
  </details>;
}

function Cut({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
}
