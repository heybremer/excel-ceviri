/** Dil seçiciler için ISO 639-1 kodları */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'İngilizce' },
  { code: 'de', label: 'Almanca' },
  { code: 'it', label: 'İtalyanca' },
  { code: 'es', label: 'İspanyolca' },
  { code: 'fr', label: 'Fransızca' },
  { code: 'nl', label: 'Flemenkçe' },
  { code: 'pl', label: 'Lehçe' },
  { code: 'pt', label: 'Portekizce' },
  { code: 'ru', label: 'Rusça' },
  { code: 'ar', label: 'Arapça' },
  { code: 'zh', label: 'Çince (Basitleştirilmiş)' },
  { code: 'ja', label: 'Japonca' },
  { code: 'ko', label: 'Korece' },
  { code: 'el', label: 'Yunanca' },
  { code: 'sv', label: 'İsveççe' },
  { code: 'no', label: 'Norveççe' },
  { code: 'da', label: 'Danca' },
  { code: 'fi', label: 'Fince' },
  { code: 'cs', label: 'Çekçe' },
  { code: 'hu', label: 'Macarca' },
  { code: 'ro', label: 'Romence' },
  { code: 'bg', label: 'Bulgarca' },
  { code: 'hr', label: 'Hırvatça' },
  { code: 'sk', label: 'Slovakça' },
  { code: 'uk', label: 'Ukraynaca' },
];

export function labelForCode(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
