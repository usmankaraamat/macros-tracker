// lift-plan -- The planned lift sessions for the next few days, read from the owner's
// Google Calendar through its secret iCal address.
//
// Secrets (Edge Function secrets, never in the repo):
//   LIFT_PLAN_ICS_URL      Google Calendar → Settings → the calendar → "Secret address in
//                          iCal format". Anyone holding it can read the whole calendar,
//                          which is why it lives here and not in the app.
//   LIFT_PLAN_OWNER_EMAIL  The one account allowed to read the plan. Every other signed-in
//                          user gets 404, so the hosted app's other users never see it.
// Only events with exercise lines ("[C] Squat | 3x6-8") are returned; the rest of the
// calendar never leaves this function.
import { authenticate, cors, json } from '../_shared/http.ts';
import { liftPlan, todayIn } from '../_shared/liftplan.js';

const TZ = 'Asia/Karachi';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed.' }, 405);
  const user = await authenticate(request);
  if (!user) return json(request, { error: 'Sign in to see your lift plan.' }, 401);
  const owner = (Deno.env.get('LIFT_PLAN_OWNER_EMAIL') || '').trim().toLowerCase();
  const icsUrl = (Deno.env.get('LIFT_PLAN_ICS_URL') || '').trim();
  if (!owner || !icsUrl) return json(request, { error: 'not_configured' }, 503);
  if ((user.email || '').toLowerCase() !== owner) return json(request, { error: 'not_available' }, 404);

  const body = await request.json().catch(() => ({}));
  const days = Math.min(14, Math.max(1, parseInt(body.days, 10) || 8));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const response = await fetch(icsUrl, { signal: ctrl.signal });
    if (!response.ok) return json(request, { error: `Calendar ${response.status}` }, 502);
    const from = todayIn(TZ);
    const plan = liftPlan(await response.text(), from, days, TZ);
    return json(request, { tz: TZ, from, days, ...plan, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return json(request, { error: (error as Error).name === 'AbortError' ? 'Calendar timed out.' : 'Could not read the calendar.' }, 502);
  } finally {
    clearTimeout(timer);
  }
});
