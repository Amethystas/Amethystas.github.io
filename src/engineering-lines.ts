// Oppositely oriented CAD edges can have the same projection. Drawing both
// starts two dash patterns at opposite ends, filling each other's gaps.
export function straightSegmentKey(path: string): string | null {
  const values = path.trim().split(/\s+/);
  if (values.length !== 6 || values[0] !== 'M' || values[3] !== 'L') return null;
  const coordinates = [values[1], values[2], values[4], values[5]].map(Number);
  if (!coordinates.every(Number.isFinite)) return null;
  const point = (x: number, y: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const a = point(coordinates[0], coordinates[1]);
  const b = point(coordinates[2], coordinates[3]);
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function removeRepeatedSegments(svg: Document): void {
  for (const group of Array.from(svg.querySelectorAll('.visible, .hidden'))) {
    const seen = new Set<string>();
    for (const path of Array.from(group.querySelectorAll('path'))) {
      const key = straightSegmentKey(path.getAttribute('d') ?? '');
      if (key === null) continue;
      if (seen.has(key)) path.remove();
      else seen.add(key);
    }
  }
}
