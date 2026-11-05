// 対応言語 (m2m100 / Whisper / Web Speech API の共通サブセット)
export const LANGUAGES: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  zh: "Chinese (Simplified)",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ru: "Russian",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ar: "Arabic",
  hi: "Hindi",
};

export function isLang(x: unknown): x is string {
  return typeof x === "string" && x in LANGUAGES;
}
