# Ledger sync — one-time Supabase setup (~5 minutes)

Sync lets the same account (identified by a passphrase, nothing else) share its
ledger across any number of devices. Data is encrypted **in the browser** with a
key derived from the passphrase — Supabase only ever stores ciphertext, and the
row id is an unguessable hash. API keys are never synced.

You set this up **once**; everyone who uses your Ledger deployment shares the
same Supabase project but each passphrase is its own isolated, encrypted account.

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) (free, no card).
2. **New project** → any name/region → set a database password (you won't need it again).

## 2. Create the table + access policy

Open **SQL Editor** → paste and run:

```sql
create table public.sync (
  id         text primary key,
  blob       text not null,
  updated_at timestamptz not null default now()
);

alter table public.sync enable row level security;

-- Anyone with the anon key may read/write rows. Safe because row ids are
-- 256-bit hashes (unguessable) and blobs are client-side encrypted anyway.
create policy "anon read"   on public.sync for select using (true);
create policy "anon insert" on public.sync for insert with check (true);
create policy "anon update" on public.sync for update using (true);
```

## 3. Get the two values

**Project Settings → API**:
- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon / public key** — the long `eyJ…` token (this one is designed to be public)

## 4. Configure Ledger

On **each device**: ⚙ Settings → *Sync* → paste the URL + anon key, choose a
**passphrase**, hit **Save sync**. Same passphrase on another device = same
account. Different passphrase = completely separate account (that's how a
friend shares your deployment without sharing your data).

The dot next to the date in the header shows sync state:
green = synced · amber pulsing = syncing · red = error (hover for why) · grey = off.

## How conflicts resolve

Merging is per-day, last-write-wins: logging lunch on your phone and dinner on
your PC on different days always both survive; editing the *same* day on two
devices keeps whichever was edited most recently. Sync always pulls and merges
before it pushes, so a device can't overwrite days it hasn't seen.

## Losing the passphrase

There is no reset — the passphrase *is* the account and the encryption key.
A new passphrase starts an empty account; your local data stays on the device
and will upload to the new account on the next sync.
