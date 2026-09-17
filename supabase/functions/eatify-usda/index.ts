import { admin, authenticate, cors, json, quotaError, release, reserve } from '../_shared/http.ts';

function keyFor(query: string) {
  return query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed.' }, 405);
  const user = await authenticate(request);
  if (!user) return json(request, { error: 'Sign in to use hosted food search.' }, 401);
  const body = await request.json().catch(() => ({}));
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 160) : '';
  const personalKey = typeof body.personalKey === 'string' && body.personalKey.length <= 200
    ? body.personalKey.trim()
    : '';
  if (!query) return json(request, { foods: [] });
  const cacheKey = keyFor(query);

  const { data: cached } = await admin.from('hosted_api_cache').select('value, expires_at')
    .eq('feature', 'eatify_usda').eq('cache_key', cacheKey).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (cached?.value) return json(request, { ...cached.value, cached: true });

  const quota = await reserve(user.id, 'eatify_usda');
  const usingPersonal = !quota.allowed && Boolean(personalKey);
  if (!quota.allowed && !usingPersonal) return quotaError(request, quota, 'food searches');
  const key = usingPersonal ? personalKey : Deno.env.get('USDA_API_KEY');
  if (!key) { if (!usingPersonal) await release(user.id, 'eatify_usda'); return json(request, { error: 'Hosted food search is not configured yet.' }, 503); }
  try {
    const response = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, dataType: ['Foundation', 'SR Legacy', 'Survey (FNDDS)'], pageSize: 10 }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`USDA ${response.status}`);
    await admin.from('hosted_api_cache').upsert({
      feature: 'eatify_usda', cache_key: cacheKey, value,
      expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), updated_at: new Date().toISOString(),
    });
    return json(request, {
      ...value, cached: false,
      ...(usingPersonal ? { personal: true } : { quota: { used: quota.used, limit: quota.daily_limit, resetAt: quota.reset_at } }),
    });
  } catch (error) {
    if (!usingPersonal) await release(user.id, 'eatify_usda');
    return json(request, { error: (error as Error).message }, 502);
  }
});
