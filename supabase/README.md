# Eatify backend

This directory adds email-account sync and quota-controlled hosted providers to
the existing Eatify Supabase project.

1. Apply `migrations/0001_accounts_and_hosted_usage.sql`.
2. Enable email magic-link authentication in Supabase Auth.
3. Add the production GitHub Pages URL to the Auth redirect allow-list.
4. Upload `GEMINI_API_KEY`, `USDA_API_KEY`, and `GEMINI_MODEL` as Edge Function
   secrets. Keep the filled env file ignored.
5. Deploy `eatify-ai` and `eatify-usda` with JWT verification enabled.

The default limits are 15 hosted AI analyses and 40 uncached USDA searches per
user per Karachi calendar day. Cache hits do not consume an allowance. The
database also enforces global daily ceilings of 1,500 and 8,000 respectively.

Manual logging, calculations, reports, saved meals, and offline use do not call
these functions and remain unlimited.
