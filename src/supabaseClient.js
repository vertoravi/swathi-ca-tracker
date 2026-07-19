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

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && anonKey ? createClient(url, anonKey) : null
export const supabaseReady = Boolean(supabase)
