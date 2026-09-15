import type { JSX } from "react";

import { formatBytes, progressFraction } from "../../core/models/catalog.ts";
import type { ModelStatus } from "../../shared/ipc.ts";

/**
 * Offers the note-writing model, in the place where its absence is felt.
 *
 * The old behaviour was to throw "Add a model in Settings", which is a dead end
 * twice over: there is no Settings screen, and it tells someone to go and solve
 * the problem themselves when the app can simply solve it here.
 */
export function LanguageModelPrompt({
  status,
  onDownload,
  onCancel,
  onDismiss,
}: {
  status: ModelStatus;
  onDownload: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const fraction = progressFraction(status.receivedBytes, status.totalBytes);
  const percent = fraction === null ? null : Math.round(fraction * 100);

  return (
    <div className="lm-prompt">
      <h3>Generating notes needs a second model</h3>
      <p>
        Transcription and note writing are different jobs. The speech model turns audio into text;
        this one reads the transcript and writes the summary, decisions and action items.
      </p>
      <p className="setup-detail">
        <strong>{status.displayName}</strong>, about {formatBytes(status.approxBytes)}. Downloaded
        once and kept, and it runs on this Mac like everything else.
      </p>

      {status.downloading ? (
        <>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-label={`Downloading ${status.displayName}`}
          >
            <div
              className={`progress-fill${fraction === null ? " indeterminate" : ""}`}
              style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
            />
          </div>
          <p className="setup-progress">
            {formatBytes(status.receivedBytes)}
            {status.totalBytes === null ? " downloaded" : ` of ${formatBytes(status.totalBytes)}`}
            {percent === null ? "" : ` (${percent}%)`}
          </p>
          <p className="setup-footnote">
            You can keep recording and taking notes while this downloads.
          </p>
          <div className="setup-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {status.error ? <p className="setup-error">{status.error}</p> : null}
          {status.resumableBytes > 0 ? (
            <p className="setup-detail">
              {formatBytes(status.resumableBytes)} already downloaded. This will pick up where it
              stopped.
            </p>
          ) : null}
          <div className="setup-actions">
            <button type="button" className="record" onClick={onDownload}>
              {status.error || status.resumableBytes > 0 ? "Resume download" : "Download"}
            </button>
            <button type="button" className="link" onClick={onDismiss}>
              Not now
            </button>
          </div>
          <p className="setup-footnote">
            Transcripts work without it. Only the Generate notes button needs this.
          </p>
        </>
      )}
    </div>
  );
}
