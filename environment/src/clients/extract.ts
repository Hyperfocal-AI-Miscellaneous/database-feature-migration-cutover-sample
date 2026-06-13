import * as fs from "fs";

const DEFAULT_BACKWARD = 30;
const DEFAULT_FORWARD = 90;
const MIN_BACKWARD = 5;
const MIN_FORWARD = 15;

/**
 * Extract the lines surrounding each pattern match in a file, as a single
 * labelled excerpt with line numbers. Every match keeps contiguous local
 * context; if the union of windows exceeds maxLines, the windows shrink
 * uniformly rather than dropping later matches.
 */
export function extractSection(
  filePath: string,
  patterns: RegExp[],
  label: string,
  maxLines = 1000,
): string {
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const hits: number[] = [];
    const seen = new Set<number>();
    for (const pat of patterns) {
      lines.forEach((l, i) => {
        if (pat.test(l) && !seen.has(i)) {
          seen.add(i);
          hits.push(i);
        }
      });
    }
    if (hits.length === 0) return `=== ${label} ===\n(pattern not found in file)`;

    const included = fitWindows(hits, lines.length, maxLines);
    const sortedIdxs = [...included].sort((a, b) => a - b);
    const extracted = sortedIdxs.map((i) => `${i + 1}: ${lines[i]}`).join("\n");
    return `=== ${label} (${lines.length} lines total, showing ${sortedIdxs.length} relevant around ${hits.length} match(es)) ===\n${extracted}`;
  } catch {
    return `=== ${label} ===\n(file not found)`;
  }
}

function fitWindows(hits: number[], lineCount: number, max: number): Set<number> {
  let backward = DEFAULT_BACKWARD;
  let forward = DEFAULT_FORWARD;
  while (true) {
    const set = new Set<number>();
    for (const h of hits) {
      for (let j = Math.max(0, h - backward); j <= Math.min(lineCount - 1, h + forward); j++) {
        set.add(j);
      }
    }
    if (set.size <= max) return set;
    if (backward <= MIN_BACKWARD && forward <= MIN_FORWARD) return set;
    backward = Math.max(MIN_BACKWARD, Math.floor(backward * 0.8));
    forward = Math.max(MIN_FORWARD, Math.floor(forward * 0.8));
  }
}
