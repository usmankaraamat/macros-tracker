import { authenticate, cors, json, quotaError, release, reserve } from '../_shared/http.ts';

const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const MAX_PROMPT = 14000;
const MAX_IMAGE = 2_800_000;

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed.' }, 405);
  const user = await authenticate(request);
  if (!user) return json(request, { error: 'Sign in to use hosted AI.' }, 401);

  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const image = typeof body.image === 'string' ? body.image : '';
  const personalKey = typeof body.personalKey === 'string' && body.personalKey.length <= 300
    ? body.personalKey.trim()
    : '';
  if (!prompt || prompt.length > MAX_PROMPT || image.length > MAX_IMAGE) {
    return json(request, { error: 'That request is too large. Shorten the text or use a smaller photo.' }, 400);
  }

  const quota = await reserve(user.id, 'eatify_ai');
  const usingPersonal = !quota.allowed && Boolean(personalKey);
  if (!quota.allowed && !usingPersonal) return quotaError(request, quota, 'AI analyses');
  const key = usingPersonal ? personalKey : Deno.env.get('GEMINI_API_KEY');
  if (!key) { if (!usingPersonal) await release(user.id, 'eatify_ai'); return json(request, { error: 'Hosted AI is not configured yet.' }, 503); }

  try {
    const parts: Array<Record<string, unknown>> = [];
    if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
    parts.push({ text: prompt });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 } }),
    });
    const envelope = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Gemini ${response.status}`);
    const text = envelope?.candidates?.[0]?.content?.parts?.filter((p: Record<string, unknown>) => !p.thought).map((p: Record<string, unknown>) => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned no content.');
    return json(request, {
      text,
      via: `${usingPersonal ? 'Personal' : 'Hosted'} Gemini · ${MODEL}`,
      ...(usingPersonal ? { personal: true } : { quota: { used: quota.used, limit: quota.daily_limit, resetAt: quota.reset_at } }),
    });
  } catch (error) {
    if (!usingPersonal) await release(user.id, 'eatify_ai');
    return json(request, { error: (error as Error).message }, 502);
  }
});
