import type { JSX } from "react";
import { useEffect, useState } from "react";

import type { AutoStopStatus } from "../../shared/ipc.ts";

/**
 * The floating countdown before a recording stops by itself.
 *
 * Rendered in its own small always-on-top window (src/main/autoStopPanel.ts),
 * because the main window is usually behind the call or closed when this
 * matters. Waving it away is one click, so a wrong guess costs nothing.
 */
export function AutoStopPanel(): JSX.Element | null {
  const [status, setStatus] = useState<AutoStopStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    // The window is opened for a countdown that has already started, so the
    // first one has to be asked for rather than waited on.
    void window.api.getCurrentRecording().then((current) => {
      if (!cancelled) setStatus((prev) => prev ?? current?.autoStop ?? null);
    });
    const unsubscribe = window.api.onAutoStopStatus(setStatus);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  if (!status) return null;
  const seconds = Math.max(0, Math.ceil((status.stopsAt - now) / 1000));

  return (
    <div className="auto-stop-panel">
      <p className="auto-stop-message">{status.message}</p>
      <p className="auto-stop-countdown">
        Stopping the recording in {seconds} {seconds === 1 ? "second" : "seconds"}.
      </p>
      <div className="auto-stop-actions">
        <button type="button" onClick={() => void window.api.respondToAutoStop("keep")}>
          Keep recording
        </button>
        <button type="button" className="stop" onClick={() => void window.api.respondToAutoStop("stop")}>
          Stop now
        </button>
      </div>
    </div>
  );
}
