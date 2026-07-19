/* ============================================================
   Supabase client (share-code sync, no auth)
   ------------------------------------------------------------
   Reads the project URL + anon key from Vite env vars:
     VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
   If either is missing (e.g. local build with no .env), `supabase`
   is null and the app runs in localStorage-only / offline mode.
   The anon key in the frontend is expected and safe: RLS on the
   `progress` table scopes every read/write to the matching share_code.
   ============================================================ */
import { createClient } from '@supabase/supabase-js'

/* Project defaults (frontend-safe: publishable/anon key, RLS-scoped to `progress`).
   Env vars override these if set in the build, so keys can be rotated without a code
   change — but the app is always configured even if the env vars don't reach the build. */
const DEFAULT_URL = 'https://qydnamqkylubrjinwpkz.supabase.co'
const DEFAULT_ANON_KEY = 'sb_publishable_r5vkExV-_WY9rH4rM-qLpw_2WI7eI5y'

const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY

export const supabase = url && anonKey ? createClient(url, anonKey) : null
export const supabaseReady = Boolean(supabase)
