import { LANGUAGES } from "./languages";

export interface Env {
  AI: Ai;
  ROOM: DurableObjectNamespace<import("./room").Room>;
  REGISTRY: DurableObjectNamespace<import("./registry").Registry>;
  /** 管理 API 用トークン (wrangler secret / GitHub Secrets で設定)。未設定なら管理 API は無効。 */
  ADMIN_TOKEN?: string;
  FINAL_TRANSLATOR?: string;
  MOCK_AI?: string;
}

const FAST_MODEL = "@cf/meta/m2m100-1.2b";
const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";

const mock = (env: Env) => env.MOCK_AI === "1" || !env.AI;

/** 高速な機械翻訳 (途中結果用・既定)。 */
export async function translateFast(env: Env, text: string, from: string, to: string): Promise<string> {
  if (mock(env)) return `[${to}] ${text}`;
  const r = (await env.AI.run(FAST_MODEL as any, { text, source_lang: from, target_lang: to } as any)) as {
    translated_text?: string;
  };
  return r.translated_text?.trim() ?? "";
}

/** LLM による確定文の翻訳。直前の文脈を渡して訳語の一貫性を上げる。 */
export async function translateLLM(
  env: Env,
  text: string,
  from: string,
  to: string,
  context: string[],
): Promise<string> {
  if (mock(env)) return `[${to}*] ${text}`;
  const sys =
    `You are a professional simultaneous interpreter. Translate the user's ${LANGUAGES[from]} utterance into natural ${LANGUAGES[to]}. ` +
    `Output ONLY the translation, no quotes, no notes. Keep proper nouns. The utterance comes from speech recognition and may contain errors; infer the intended meaning.`;
  const ctx = context.length ? `Previous utterances (for context only, do not translate):\n${context.join("\n")}\n\n` : "";
  try {
    const r = (await env.AI.run(LLM_MODEL as any, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `${ctx}Utterance to translate:\n${text}` },
      ],
      max_tokens: 512,
      temperature: 0.2,
    } as any)) as { response?: string };
    const out = r.response?.trim();
    if (out) return out;
  } catch (e) {
    console.error("llm translate failed, falling back", e);
  }
  return translateFast(env, text, from, to);
}

/** Whisper による音声認識 (サーバー STT モード)。audio は 16kHz mono WAV。 */
export async function transcribe(env: Env, wav: ArrayBuffer, lang: string): Promise<string> {
  if (mock(env)) return `(audio ${wav.byteLength}B)`;
  const r = (await env.AI.run(STT_MODEL as any, {
    audio: arrayBufferToBase64(wav),
    language: lang,
    vad_filter: true,
  } as any)) as { text?: string };
  return r.text?.trim() ?? "";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
