/** Excel sütun harfini 0-tabanlı indekse çevirir (A→0, Z→25, AA→26). */
export function columnLetterToIndex(letters: string): number {
  const s = letters.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!s.length) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 64;
    if (c < 1 || c > 26) return 0;
    n = n * 26 + c;
  }
  return n - 1;
}

/** 0-tabanlı indeksi Excel sütun harfine çevirir. */
export function indexToColumnLetter(index: number): string {
  let i = index + 1;
  let out = '';
  while (i > 0) {
    const r = (i - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    i = Math.floor((i - 1) / 26);
  }
  return out || 'A';
}

/** Mevcut sütun genişliğine göre A, B, C… listesi üretir. */
export function columnOptions(maxUsedIndex: number): string[] {
  const n = Math.max(maxUsedIndex + 1, 26);
  const list: string[] = [];
  for (let i = 0; i < n; i++) {
    list.push(indexToColumnLetter(i));
  }
  return list;
}
