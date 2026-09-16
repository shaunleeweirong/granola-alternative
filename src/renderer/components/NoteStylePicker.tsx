import type { JSX } from "react";

import { NOTE_STYLES, CUSTOM_STYLE_ID, type NotePreferences } from "../../core/notes/noteStyles.ts";

/**
 * Chooses what "Generate notes" produces.
 *
 * Only the shape is on offer. The accuracy rules are not listed here because
 * they are not negotiable: the value of a meeting record is that it did not
 * make anything up.
 */
export function NoteStylePicker({
  preferences,
  onChange,
  onClose,
}: {
  preferences: NotePreferences;
  onChange: (next: NotePreferences) => void;
  onClose: () => void;
}): JSX.Element {
  const isCustom = preferences.styleId === CUSTOM_STYLE_ID;

  return (
    <div className="style-picker">
      <div className="style-picker-head">
        <h3>Note style</h3>
        <button type="button" className="link" onClick={onClose}>
          Done
        </button>
      </div>

      <ul className="style-list">
        {NOTE_STYLES.map((style) => (
          <li key={style.id}>
            <label className={preferences.styleId === style.id ? "selected" : undefined}>
              <input
                type="radio"
                name="note-style"
                value={style.id}
                checked={preferences.styleId === style.id}
                onChange={() => onChange({ ...preferences, styleId: style.id })}
              />
              <span className="style-label">{style.label}</span>
              <span className="style-description">{style.description}</span>
            </label>
          </li>
        ))}
      </ul>

      <label className="field-label" htmlFor="note-instructions">
        {isCustom ? "Your instructions" : "Extra instructions (optional)"}
      </label>
      <textarea
        id="note-instructions"
        className="style-instructions"
        value={preferences.instructions}
        placeholder={
          isCustom
            ? "Describe the notes you want. For example: a table of every commitment made, with who made it and when it is due."
            : "Anything to add. For example: always list budget figures, or write in British English."
        }
        onChange={(event) => onChange({ ...preferences, instructions: event.target.value })}
      />
      <p className="setup-footnote">
        {isCustom
          ? "Leave this empty and detailed notes are produced instead."
          : "Added on top of the style above."}{" "}
        Accuracy rules always apply: nothing is invented, and names are kept exactly.
      </p>
    </div>
  );
}
