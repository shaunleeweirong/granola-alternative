import type { JSX } from "react";

import { formatBytes, progressFraction } from "../../core/models/catalog.ts";
import type { ModelStatus } from "../../shared/ipc.ts";

/**
 * First-run screen for fetching the speech model.
 *
 * The model is not shipped inside the installer, so this is the first thing a
 * new user sees. It has one job beyond starting the download: explain why an
 * app that promises to keep everything on your machine is asking to download
 * most of a gigabyte.
 */
export function ModelSetup({
  status,
  onDownload,
  onCancel,
  onSkip,
}: {
  status: ModelStatus;
  onDownload: () => void;
  onCancel: () => void;
  onSkip: () => void;
}): JSX.Element {
  const fraction = progressFraction(status.receivedBytes, status.totalBytes);
  const percent = fraction === null ? null : Math.round(fraction * 100);

  return (
    <div className="setup">
      <div className="setup-card">
        <h2>One-time setup</h2>
        <p>
          Meeting Notes transcribes on this Mac. Nothing is sent anywhere, which means the speech
          model has to live here rather than on a server.
        </p>
        <p className="setup-detail">
          <strong>{status.displayName}</strong>, about {formatBytes(status.approxBytes)}.{" "}
          {status.description}
        </p>
        <p className="setup-detail">
          It is downloaded once and kept, so updating the app later does not download it again.
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
            <div className="setup-actions">
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" className="link" onClick={onSkip}>
                Continue in the background
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
              <button type="button" className="link" onClick={onSkip}>
                Not now
              </button>
            </div>
            <p className="setup-footnote">
              Without it the app still records and saves meetings, but cannot transcribe them.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
