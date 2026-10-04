/**
 * Track edits as pure functions: what a drag-and-drop on the track MEANS in
 * the notation. The notation text is the source of truth (a drop rewrites
 * the text and everything re-renders from the parse), so a drop handler is
 * just: translate the gesture with one of these, write the text, refresh.
 * Pure and DOM-free so the rules are testable in Node — the drag wiring that
 * feeds them is the thin part, these are the parts that can silently lie.
 */

/** The chord-stream rest token: a bar with no chord (see parseRiff). */
export const CHORD_REST = "-";

/**
 * The chord tokens of the notation's chord line — the first line that is not
 * a directive, a comment, or a tab lane — rest tokens included. A token
 * starting with a comment marker ends the line, matching the parser (a
 * trailing `# ...` is a comment, not more chords). Empty when the notation
 * has no chord line.
 */
export function chordTokensFromText(text: string): string[] {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (/^\s*[eBGDAE]\s*\|/.test(line)) continue;
    if (/^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(trimmed)) continue;
    const tokens: string[] = [];
    for (const token of trimmed.split(/[\s,;|]+/)) {
      if (!token) continue;
      if (token.startsWith("#") || token.startsWith("//")) break;
      tokens.push(token);
    }
    return tokens;
  }
  return [];
}

/**
 * Move the chord at TOKEN index `from` to TOKEN index `to`: the target bar's
 * chord is replaced, and the bar the chord left becomes a rest. (Replace, not
 * swap — the user's call. The stream is positional, so without the rest the
 * chords between the two bars would silently shift.) Dropping past the last
 * bar extends the stream with rest bars. Out-of-range source or same index
 * = no change.
 */
export function moveChordToken(tokens: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= tokens.length) {
    return tokens;
  }
  const next = addChordToken(tokens, to, tokens[from]);
  next[from] = CHORD_REST;
  return next;
}

/**
 * Set the chord at TOKEN index `bar` to `name` — a builder chip dropped on
 * the chord lane. Same replace semantics as a move, minus the vacated bar:
 * the target is overwritten, bars past the end pad with rests.
 */
export function addChordToken(tokens: string[], bar: number, name: string): string[] {
  if (bar < 0) return tokens;
  const next = tokens.slice();
  while (next.length <= bar) next.push(CHORD_REST);
  next[bar] = name;
  return next;
}

/**
 * Which token index the n-th non-rest chord sits at, or -1. Chord regions
 * count chord EVENTS (rests are not events), but moves edit TOKENS (rests
 * hold positions) — this is the bridge between the two numberings.
 */
export function tokenIndexForChordOrdinal(tokens: string[], ordinal: number): number {
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === CHORD_REST) continue;
    if (seen === ordinal) return i;
    seen++;
  }
  return -1;
}

/**
 * The chord events' ordinal numbering skips rests; this is the count of
 * non-rest chords strictly before token index `i` — the event ordinal the
 * chord at `i` will have (or where a chord inserted at `i` will land).
 */
function eventOrdinalBefore(tokens: string[], i: number): number {
  let n = 0;
  for (let k = 0; k < i && k < tokens.length; k++) {
    if (tokens[k] !== CHORD_REST) n++;
  }
  return n;
}

/**
 * Pins are index-aligned with the chord EVENTS (rests hold no pin), so a
 * chord move must carry the pinned shape with its chord — and the replaced
 * chord's pin must die — or every pin between the two bars silently lands on
 * the wrong chord. Replace semantics (see moveChordToken): the moved chord's
 * pin moves to the target's new event ordinal; the target's pin is dropped;
 * pins over a rest bar hold no slot, so a move onto a rest just relocates.
 */
export function movePins<T>(
  pins: (T | null)[],
  tokens: string[],
  from: number,
  to: number,
): (T | null)[] {
  if (from === to || from < 0 || to < 0 || from >= tokens.length) return pins.slice();
  const next = pins.slice();
  const ordFrom = eventOrdinalBefore(tokens, from);
  const movedPin = next.splice(ordFrom, 1)[0] ?? null;
  if (to < tokens.length && tokens[to] !== CHORD_REST) {
    // The target held a chord event; after its replacement the array has one
    // fewer entry before it, so its ordinal shifted down by one iff the
    // source was before it.
    const ordTo = eventOrdinalBefore(tokens, to);
    next.splice(ordFrom < ordTo ? ordTo - 1 : ordTo, 1);
  }
  next.splice(eventOrdinalBefore(moveChordToken(tokens, from, to), to), 0, movedPin);
  return next;
}

/**
 * A chip drop writes a chord onto bar `bar`: if it lands on a real chord,
 * the chord's event ordinal is unchanged and its pin is REPLACED by the
 * chip's pin; if it lands on a rest (or extends the stream), the new event
 * shifts every later pin up one, so splice it in rather than overwriting.
 */
export function insertOrReplacePin<T>(
  pins: (T | null)[],
  tokens: string[],
  bar: number,
  pin: T,
): (T | null)[] {
  const next = pins.slice();
  const at = eventOrdinalBefore(addChordToken(tokens, bar, "_"), bar);
  if (bar < tokens.length && tokens[bar] !== CHORD_REST) {
    next[at] = pin;
  } else {
    next.splice(at, 0, pin);
  }
  return next;
}

/**
 * The lowest fret on a string that sounds a pitch class (0 = the open
 * string). What a note-chip drop writes: the user thinks in notes, the app
 * answers in frets.
 */
export function fretForPitchClass(pitchClass: number, stringMidi: number): number {
  return ((pitchClass - stringMidi) % 12 + 12) % 12;
}

/**
 * Shared cell-write rules: ragged lanes are made uniform (the notation
 * requires equal-width lanes), a string with no lane yet gets one, a
 * two-digit fret clears its shadow column and is refused at the lane's end
 * (the text would grow one lane and fail the equal-length parse). Returns
 * the row written to, or null when the write is out of range.
 */
function writeFret(
  lanes: Map<number, (number | "x" | null)[]>,
  to: { string: number; column: number },
  fret: number,
): (number | "x" | null)[] | null {
  let columns = 0;
  for (const cells of lanes.values()) columns = Math.max(columns, cells.length);
  for (const [string, cells] of lanes) {
    if (cells.length < columns) {
      const row = cells.slice();
      while (row.length < columns) row.push(null);
      lanes.set(string, row);
    }
  }
  let target = lanes.get(to.string);
  if (!target) {
    target = new Array(columns).fill(null) as (number | "x" | null)[];
    lanes.set(to.string, target);
  }
  if (to.column < 0 || to.column >= columns) return null;
  if (fret >= 10 && to.column + 1 >= columns) return null;
  target[to.column] = fret;
  if (fret >= 10) target[to.column + 1] = null;
  return target;
}

/**
 * Place a tab note (a note-chip drop): write the fret at the cell, with the
 * shared write rules. Returns false when nothing was written.
 */
export function setLaneNote(
  lanes: Map<number, (number | "x" | null)[]>,
  to: { string: number; column: number },
  fret: number,
): boolean {
  return writeFret(lanes, to, fret) !== null;
}

/**
 * Delete the tab note at a cell (a track click with an empty entry). The
 * cell clears to null; lane widths are unchanged (a cleared cell is a
 * rest column). Returns false when there was nothing there to clear.
 */
export function clearLaneNote(
  lanes: Map<number, (number | "x" | null)[]>,
  at: { string: number; column: number },
): boolean {
  const cells = lanes.get(at.string);
  if (!cells || at.column < 0 || at.column >= cells.length) return false;
  if (cells[at.column] === null) return false;
  cells[at.column] = null;
  return true;
}

/**
 * Move one tab note: clear its cell, write the fret at the target cell. The
 * gesture is fret-preserving — a literal tab move, the digit travels and the
 * pitch follows the new string (the user's call over pitch-preserving).
 * Overwrites whatever the target cell held. Returns false when nothing moved.
 */
export function moveLaneNote(
  lanes: Map<number, (number | "x" | null)[]>,
  from: { string: number; column: number },
  to: { string: number; column: number },
): boolean {
  if (from.string === to.string && from.column === to.column) return true; // dropped on itself
  const fret = lanes.get(from.string)?.[from.column];
  if (typeof fret !== "number") return false;
  if (!writeFret(lanes, to, fret)) return false;
  // The source clears AFTER the write lands: within one lane the two can
  // share a row, and clearing first would lose the fret to the shadow rule.
  lanes.get(from.string)![from.column] = null;
  return true;
}

/**
 * Replace the notation's chord line with `chordLine`, or INSERT it after the
 * last directive/comment line when the notation has none (a tab-only riff
 * gaining its first chord). Tab lanes, directives, and comments are
 * preserved. Extracted from riff-main's applyProgression so the surgery is
 * testable.
 */
export function replaceChordLine(text: string, chordLine: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !replaced &&
      trimmed &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("//") &&
      !/^\s*[eBGDAE]\s*\|/.test(line) &&
      !/^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(trimmed)
    ) {
      out.push(chordLine);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) {
    let insertAt = 0;
    for (let i = 0; i < out.length; i++) {
      const t = out[i].trim();
      if (
        t &&
        (t.startsWith("#") || t.startsWith("//") || /^(tempo|bpm|bar|step|grid|strum|release)\s+/i.test(t))
      ) {
        insertAt = i + 1;
      }
    }
    out.splice(insertAt, 0, chordLine);
  }
  return out.join("\n");
}
