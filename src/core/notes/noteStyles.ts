/**
 * What "Generate notes" should produce.
 *
 * Only the *shape* of the output is selectable. The accuracy rules (never
 * invent a fact, keep exact names, separate discussed from decided) are not,
 * because they are the reason to trust the output at all: a note style that
 * could switch them off would quietly turn a meeting record into fiction.
 *
 * Pure, so every style can be checked without a model or a filesystem.
 */

export interface NoteStyle {
  id: string;
  /** Shown in the picker. */
  label: string;
  /** One line explaining what this produces, also shown in the picker. */
  description: string;
  /**
   * The output format the model is asked for. Replaces the FORMAT block of
   * the system prompt; the rules above it are untouched.
   */
  format: string;
}

export const DEFAULT_STYLE_ID = "detailed";
export const CUSTOM_STYLE_ID = "custom";

const DETAILED_FORMAT = `- No title, date, attendee list, preamble, table, or horizontal rule. Omit any section with nothing to say.

## Summary
3-5 bullets: purpose, key subjects, major outcomes, immediate next steps.

## Discussion
Descriptive topic subheadings named after the actual client, project, or initiative, with enough context that someone who missed the meeting understands what happened and why.

## Decisions
Only decisions that were explicitly made or clearly agreed.

## Action Items
Only actions someone committed to or was asked to do; never turn a discussion topic into an action item. One checkbox per item in the form \`- [ ] Action (Owner)\`. Put a stated due date inside the action text. When the transcript shows no owner, end the line after the action; never write a placeholder.

## Open Questions
Unresolved questions, dependencies, and requested follow-ups.`;

export const NOTE_STYLES: readonly NoteStyle[] = Object.freeze([
  {
    id: DEFAULT_STYLE_ID,
    label: "Detailed notes",
    description: "Summary, discussion by topic, decisions, action items and open questions.",
    format: DETAILED_FORMAT,
  },
  {
    id: "brief",
    label: "Brief summary",
    description: "A short summary and the action items. Nothing else.",
    format: `- No title, date, attendee list, preamble, table, or horizontal rule. Omit any section with nothing to say.
- Be short. A reader should take this in at a glance.

## Summary
At most 5 bullets covering what the meeting was about and what came out of it.

## Action Items
Only actions someone committed to or was asked to do. One checkbox per item in the form \`- [ ] Action (Owner)\`. Put a stated due date inside the action text. When the transcript shows no owner, end the line after the action.`,
  },
  {
    id: "actions",
    label: "Action items only",
    description: "Just the checklist of what people committed to do.",
    format: `- Output nothing but the action items. No headings, no summary, no preamble, no closing line.
- One checkbox per item in the form \`- [ ] Action (Owner)\`. Put a stated due date inside the action text. When the transcript shows no owner, end the line after the action; never write a placeholder.
- Only actions someone committed to or was asked to do. Never turn a discussion topic into an action item.
- If nobody committed to anything, output exactly: No action items.`,
  },
  {
    id: "executive",
    label: "Executive summary",
    description: "A few paragraphs of prose for someone who was not there.",
    format: `- Prose, not bullets. No headings, no checkboxes, no preamble.
- Three or four short paragraphs at most.
- Lead with the outcome: what was decided or what changes as a result. Then the reasoning. Then what happens next and who is doing it.
- Written for someone senior who did not attend and will read it once.`,
  },
  {
    id: "minutes",
    label: "Full minutes",
    description: "Chronological record of the meeting, in order of discussion.",
    format: `- No title, date, attendee list, preamble, table, or horizontal rule.
- Follow the order the meeting actually happened in, rather than grouping by theme.
- Use a heading per topic as it came up, in sequence.
- Under each, record what was said, by whom where the transcript makes that clear, and what was concluded.
- End with a "## Action Items" section: one checkbox per item in the form \`- [ ] Action (Owner)\`.`,
  },
  {
    id: CUSTOM_STYLE_ID,
    label: "Custom",
    description: "Describe the output you want in your own words.",
    format: "",
  },
]);

export function findStyle(id: string | null | undefined): NoteStyle | undefined {
  return NOTE_STYLES.find((style) => style.id === id);
}

/** The style to use, falling back to the default for an unknown or missing id. */
export function resolveStyle(id: string | null | undefined): NoteStyle {
  return findStyle(id) ?? (findStyle(DEFAULT_STYLE_ID) as NoteStyle);
}

export interface NotePreferences {
  styleId: string;
  /** Extra wording from the user. The whole format when the style is custom. */
  instructions: string;
}

export const DEFAULT_NOTE_PREFERENCES: NotePreferences = Object.freeze({
  styleId: DEFAULT_STYLE_ID,
  instructions: "",
});

/**
 * The FORMAT block for a set of preferences.
 *
 * The custom style is the user's own words. Empty custom instructions fall back
 * to the detailed format rather than asking a model for no format at all, which
 * produces whatever it feels like.
 */
export function buildFormatBlock(prefs: NotePreferences): string {
  const style = resolveStyle(prefs.styleId);
  const instructions = prefs.instructions.trim();

  if (style.id === CUSTOM_STYLE_ID) {
    return instructions || resolveStyle(DEFAULT_STYLE_ID).format;
  }
  if (!instructions) return style.format;

  return `${style.format}

ADDITIONAL INSTRUCTIONS FROM THE USER
These refine the format above. They never override the rules about accuracy, invented facts, or exact names.
${instructions}`;
}
