export function normalizeId(value: string): string | null {
  const match = /^(\d{2}[ab]?)_?(\d+)$/i.exec(value.trim());
  return match ? `${match[1].toLowerCase()}_${match[2]}` : null;
}

export function readModelId(search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (params.has('id')) return params.get('id')!;
  if (!hash || hash === '#') return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return '';
  }
}
