import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { formatTimestamp, mergeSegments } from "../../core/transcript/merge.ts";
import type { TranscriptSegment } from "../../core/transcript/types.ts";

const LABELS = { you: "You", them: "Them" } as const;

export function TranscriptPanel({
  segments,
  live,
}: {
  segments: TranscriptSegment[];
  live: boolean;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Follow the transcript unless the reader has scrolled up to look at something.
  useEffect(() => {
    if (!live || !pinnedRef.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [segments, live]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const ordered = mergeSegments(segments);

  return (
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <h2>Transcript {live ? <span className="live-dot" aria-label="recording" /> : null}</h2>
      {ordered.length === 0 ? (
        <p className="hint">
          {live ? "Listening… text appears as each phrase completes." : "No transcript for this meeting."}
        </p>
      ) : (
        ordered.map((segment) => (
          <p key={segment.id} className={`line ${segment.channel}`}>
            <span className="stamp">{formatTimestamp(segment.startMs)}</span>
            <span className="speaker">{LABELS[segment.channel]}</span>
            <span className="text">{segment.text}</span>
          </p>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
