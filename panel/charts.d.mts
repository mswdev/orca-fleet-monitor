// Types for charts.mjs.
export function seriesPaths(
  values: readonly (number | null)[],
  w: number,
  h: number,
  pad?: number
): { line: string; area: string; points: number }
