import { labelForCode } from './languages';

function openAiUrl(): string {
  return '/openai/v1/chat/completions';
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

/**
 * OpenAI Chat Completions ile tek metin çevirisi.
 * Boş metin aynen döner. Rate-limit ve paralel istek yönetimi çağıran tarafta yapılır.
 */
export async function translateWithOpenAI(
  text: string,
  sourceLang: string,
  targetLang: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const t = text.trim();
  if (!t) return text;

  const srcName = labelForCode(sourceLang);
  const tgtName = labelForCode(targetLang);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(openAiUrl(), {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are a professional translator. Output ONLY the translated text — no quotes, no explanations, no markdown. Preserve the original formatting and line breaks.',
        },
        {
          role: 'user',
          content: `Translate from ${srcName} (${sourceLang}) to ${tgtName} (${targetLang}):\n\n${t}`,
        },
      ],
    }),
  });

  const data = (await res.json()) as ChatResponse;

  if (!res.ok) {
    throw new Error(data.error?.message ?? `OpenAI hatası: ${res.status}`);
  }

  const out = data.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error('Model boş yanıt döndürdü.');
  }
  return out.trim();
}
