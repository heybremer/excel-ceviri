import { labelForCode } from './languages';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Geliştirme: Vite proxy; üretim: aynı origin üzerinden Express proxy */
function openAiUrl(): string {
  return '/openai/v1/chat/completions';
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

/**
 * OpenAI Chat Completions ile çeviri (gpt-4o-mini vb.).
 * Boş metin aynen döner.
 */
export async function translateWithOpenAI(
  text: string,
  sourceLang: string,
  targetLang: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<string> {
  const t = text.trim();
  if (!t) return text;

  const key = apiKey.trim();
  if (!key) {
    throw new Error('OpenAI API anahtarı gerekli.');
  }

  const sourceName = labelForCode(sourceLang);
  const targetName = labelForCode(targetLang);

  const body = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system' as const,
        content:
          'You are an expert translator. Output only the translated text. Do not add quotes, explanations, or markdown. Preserve line breaks within the text.',
      },
      {
        role: 'user' as const,
        content: `Translate the following text from ${sourceName} (${sourceLang}) to ${targetName} (${targetLang}).\n\n${t}`,
      },
    ],
  };

  const res = await fetch(openAiUrl(), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as ChatCompletionResponse;

  if (!res.ok) {
    const msg = data.error?.message ?? `OpenAI hatası: ${res.status}`;
    throw new Error(msg);
  }

  const out = data.choices?.[0]?.message?.content;
  if (typeof out !== 'string') {
    throw new Error('Model yanıtı okunamadı.');
  }
  return out.trim();
}

/** Kısa gecikme — çok hızlı ardışık isteklerde sınır riskini azaltır */
export const REQUEST_DELAY_MS = 120;

export async function translateWithDelay(
  text: string,
  sourceLang: string,
  targetLang: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<string> {
  await sleep(REQUEST_DELAY_MS);
  return translateWithOpenAI(text, sourceLang, targetLang, apiKey, model, signal);
}
