import { el } from "./render.js";

/**
 * Visual tab editor: a grid of clickable cells that replaces the character-column
 * tab lanes in the notation. One row per string (e B G D A E, high to low), one
 * column per step. Click a cell to cycle fret → fret+1 → … → empty; right-click
 * clears. The grid is the single source of truth for tab content — it generates
 * lane text for the notation on every change, so there is no separate text format
 * to keep in sync.
 *
 * The grid is deliberately dumb: it knows about frets and steps, not about beats,
 * bars, or tempo. Those live in the notation text and the transport; the grid's
 * only job is to answer "what fret (if any) is on this string at this column?"
 */

const STRING_LETTERS = "eBGDAE";
/** Tuning index → lane label. Index 5 = high e, index 0 = low E. */
const LABEL_FOR_STRING = ["E", "A", "D", "G", "B", "e"];
/** Fret values the click cycle passes through, in order. */
const CYCLE_FRETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export interface TabEditorOptions {
  beatsPerBar: number;
  stepBeats: number;
  /** Called with the full lane map whenever any cell changes. */
  onChange: (lanes: Map<number, (number | "x" | null)[]>) => void;
}

export class TabEditor {
  private readonly container: HTMLElement;
  private readonly opts: TabEditorOptions;
  /** cells[stringIndex][column] = fret | null */
  private cells: (number | null)[][];
  private columns: number;

  constructor(container: HTMLElement, opts: TabEditorOptions) {
    this.container = container;
    this.opts = opts;
    this.cells = [];
    this.columns = 0;
  }

  /** Replace the whole grid from a lane map (e.g. after a re-parse). */
  setLanes(lanes: Map<number, (number | "x" | null)[]>): void {
    let maxCols = 0;
    for (const cells of lanes.values()) maxCols = Math.max(maxCols, cells.length);
    this.columns = Math.max(8, maxCols);
    this.cells = [];
    for (let s = 0; s < 6; s++) {
      const lane = lanes.get(s) ?? [];
      const row: (number | null)[] = [];
      for (let c = 0; c < this.columns; c++) {
        const cell = lane[c];
        row.push(typeof cell === "number" ? cell : null);
      }
      this.cells.push(row);
    }
    this.render();
  }

  /** Extend or shrink the column count, preserving existing cells. */
  setColumns(columns: number): void {
    const clamped = Math.max(8, Math.min(128, columns));
    if (clamped === this.columns) return;
    const next: (number | null)[][] = [];
    for (let s = 0; s < 6; s++) {
      const row: (number | null)[] = [];
      for (let c = 0; c < clamped; c++) {
        row.push(this.cells[s]?.[c] ?? null);
      }
      next.push(row);
    }
    this.cells = next;
    this.columns = clamped;
    this.render();
    this.emit();
  }

  get columnCount(): number {
    return this.columns;
  }

  /** Current state as a lane map the notation parser understands. */
  getLanes(): Map<number, (number | "x" | null)[]> {
    const lanes = new Map<number, (number | "x" | null)[]>();
    for (let s = 0; s < 6; s++) {
      if (this.cells[s].some((f) => f !== null)) lanes.set(s, this.cells[s]);
    }
    return lanes;
  }

  /** Cycle a cell to the next fret, or null → first fret. Right-click clears. */
  private cycle(stringIndex: number, column: number, clear: boolean): void {
    if (clear) {
      this.cells[stringIndex][column] = null;
    } else {
      const current = this.cells[stringIndex][column];
      if (current === null) {
        this.cells[stringIndex][column] = CYCLE_FRETS[0];
      } else {
        const idx = CYCLE_FRETS.indexOf(current);
        this.cells[stringIndex][column] =
          idx === -1 || idx === CYCLE_FRETS.length - 1 ? null : CYCLE_FRETS[idx + 1];
      }
    }
    this.render();
    this.emit();
  }

  /** Notify the owner that the grid changed. */
  private emit(): void {
    this.opts.onChange(this.getLanes());
  }

  /** Build the grid DOM. Rebuilt from scratch on every change — it is small. */
  private render(): void {
    const perBar = this.opts.beatsPerBar / this.opts.stepBeats;
    const table = el("div", "tab-grid") as HTMLDivElement;

    // Header row: column numbers, with a bar marker at each bar line.
    const headRow = el("div", "tab-row tab-head");
    headRow.appendChild(el("div", "tab-label", ""));
    for (let c = 0; c < this.columns; c++) {
      const isBar = c % perBar === 0;
      const num = el("div", "tab-colnum" + (isBar ? " tab-colnum-bar" : ""), String(c + 1));
      headRow.appendChild(num);
    }
    table.appendChild(headRow);

    // One row per string, high e first (reading order).
    for (let s = 5; s >= 0; s--) {
      const row = el("div", "tab-row");
      row.appendChild(el("div", "tab-label", LABEL_FOR_STRING[s]));
      for (let c = 0; c < this.columns; c++) {
        const fret = this.cells[s][c];
        const cell = el(
          "button",
          "tab-cell" + (fret !== null ? " tab-cell-on" : ""),
          fret !== null ? String(fret) : "",
        ) as HTMLButtonElement;
        cell.type = "button";
        cell.dataset.string = String(s);
        cell.dataset.column = String(c);
        if (fret !== null) cell.title = `${STRING_LETTERS[s]} string, fret ${fret}`;
        cell.addEventListener("click", () => this.cycle(s, c, false));
        cell.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.cycle(s, c, true);
        });
        row.appendChild(cell);
      }
      table.appendChild(row);
    }

    this.container.replaceChildren(table);
  }
}
