import type { JSX } from "react";

/** A moving meter per channel is the cheapest possible proof that capture is
 *  alive. Silently recording nothing is the most common failure in this
 *  category, and a transcript arrives far too late to catch it. */
export function LevelMeter({ label, level }: { label: string; level: number }): JSX.Element {
  // RMS is tiny for speech, so map it logarithmically onto the bar.
  const db = level > 0 ? 20 * Math.log10(level) : -80;
  const filled = Math.max(0, Math.min(1, (db + 60) / 60));

  return (
    <div className="meter" title={`${label}: ${db.toFixed(0)} dBFS`}>
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${(filled * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}
