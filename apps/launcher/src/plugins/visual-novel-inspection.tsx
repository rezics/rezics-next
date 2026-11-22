import type { VisualNovelInspection } from '@rezics/launcher-contract';
import { MetaLine } from '@rezics/ui/meta-line';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';

export function InspectionSummary({
  report,
  saveFolderOverride,
}: {
  report: VisualNovelInspection | null;
  saveFolderOverride?: string | null | undefined;
}) {
  if (report && report.engine !== 'unknown') {
    const save =
      saveFolderOverride === undefined ? (report.detectedSaveDirectory ?? report.saveName) : saveFolderOverride;
    const game = typeof saveFolderOverride === 'string' ? undefined : report.gameSaveDirectory;
    const details = [report.title, report.version && `Version ${report.version}`];
    const hasDetails = details.some(Boolean);
    return (
      <Alert role="status">
        <AlertTitle>{report.engine === 'renpy' ? 'Ren’Py detected' : 'KiriKiri detected'}</AlertTitle>
        {(hasDetails || game || save) && (
          <AlertDescription className="grid gap-1 text-wrap [overflow-wrap:anywhere]">
            {hasDetails && <MetaLine items={details} />}
            {game && (
              <div>
                <span className="font-medium text-foreground">Game save folder</span> {game}
              </div>
            )}
            {save && (
              <div>
                <span className="font-medium text-foreground">Save folder</span> {save}
              </div>
            )}
          </AlertDescription>
        )}
      </Alert>
    );
  }
  return (
    <Alert role="status">
      <AlertDescription>
        {report
          ? 'No supported game metadata found. Enter the game details and select its save folder.'
          : 'Could not inspect this game. You can enter its details manually.'}
      </AlertDescription>
    </Alert>
  );
}
