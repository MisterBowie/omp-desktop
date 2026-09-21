import type { FontOption } from "./fonts";

/**
 * Fixed-height windowing model for the Settings font picker list, mirroring
 * the virtual-scroller pattern DBX uses for its data grid: only the rows
 * intersecting the scroll viewport (plus overscan) are ever in the DOM, so
 * opening a list with hundreds of installed families neither floods the DOM
 * nor forces Chromium to load and shape hundreds of font files at once.
 */

export const FONT_OPTION_ROW_HEIGHT = 32;
export const FONT_GROUP_ROW_HEIGHT = 28;
export const FONT_LIST_OVERSCAN = 8;

export type FontListRow =
  | {
      kind: "group";
      index: number;
      id: string;
      label: string;
    }
  | {
      kind: "option";
      index: number;
      id: string;
      option: FontOption;
      optionIndex: number;
    };

export type FontListLayout = {
  rows: FontListRow[];
  /** Fixed pixel height of each row, aligned with {@link FontListRow.index}. */
  heights: number[];
  /** Prefix sums of `heights`; `offsets[i]` is the top of row `i`. */
  offsets: number[];
  /** Flat row index for each option index (used to scroll a highlight into view). */
  optionRowIndex: number[];
  totalHeight: number;
};

export function buildFontListLayout(
  options: readonly FontOption[],
  groupLabel: (group: string) => string,
): FontListLayout {
  const rows: FontListRow[] = [];
  const heights: number[] = [];
  options.forEach((option, optionIndex) => {
    const previous = optionIndex === 0 ? null : options[optionIndex - 1];
    if (!previous || previous.group !== option.group) {
      rows.push({
        kind: "group",
        index: rows.length,
        id: `group:${option.group}`,
        label: groupLabel(option.group),
      });
      heights.push(FONT_GROUP_ROW_HEIGHT);
    }
    rows.push({
      kind: "option",
      index: rows.length,
      id: `option:${option.group}:${option.value}`,
      option,
      optionIndex,
    });
    heights.push(FONT_OPTION_ROW_HEIGHT);
  });
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index] + heights[index];
  }
  const optionRowIndex = new Array<number>(options.length);
  for (const row of rows) {
    if (row.kind === "option") optionRowIndex[row.optionIndex] = row.index;
  }
  return { rows, heights, offsets, optionRowIndex, totalHeight: offsets[rows.length] };
}

/** First row index whose top edge is at or below `y` (binary search). */
function firstRowAtOrBelow(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visibleRowRange(
  layout: FontListLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = FONT_LIST_OVERSCAN,
): { start: number; end: number } {
  if (layout.rows.length === 0) return { start: 0, end: 0 };
  const start = Math.max(
    0,
    firstRowAtOrBelow(layout.offsets, Math.max(0, scrollTop)) - overscan,
  );
  const end = Math.min(
    layout.rows.length,
    firstRowAtOrBelow(layout.offsets, scrollTop + viewportHeight) +
      overscan +
      1,
  );
  return { start, end };
}
