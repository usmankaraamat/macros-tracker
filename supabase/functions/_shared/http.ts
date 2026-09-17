import { createClient } from 'jsr:@supabase/supabase-js@2';

export const ALLOWED_HEADERS = 'authorization, apikey, x-client-info, content-type';
export function cors(request: Request) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? ALLOWED_HEADERS,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400',
  };
}
export function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
export const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

export async function authenticate(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const db = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await db.auth.getUser();
  return error ? null : data.user;
}

export async function reserve(userId: string, feature: string) {
  const { data, error } = await admin.rpc('reserve_hosted_quota', { p_user_id: userId, p_feature: feature });
  if (error) throw error;
  return data?.[0] ?? { allowed: false, reason: 'unavailable', used: 0, daily_limit: 0, reset_at: '' };
}
export async function release(userId: string, feature: string) {
  await admin.rpc('release_hosted_quota', { p_user_id: userId, p_feature: feature });
}
export function quotaError(request: Request, quota: Record<string, unknown>, noun: string) {
  const message = quota.reason === 'user_limit'
    ? `Today's hosted ${noun} allowance is used. Add your own key under Advanced providers or try again tomorrow.`
    : quota.reason === 'global_limit'
      ? `Hosted ${noun} is at its safety limit today. Add your own key under Advanced providers or try again tomorrow.`
      : `Hosted ${noun} is temporarily unavailable.`;
  return json(request, { error: 'quota_exhausted', message, quota }, 429);
}
