/**
 * Supabase browser client — the single source of the auth session.
 *
 * Reads the PUBLIC project credentials from Vite env (baked into the bundle at
 * build time; the anon key is publishable by design — RLS is what protects the
 * data, not key secrecy). When the two vars are absent — i.e. local dev against
 * a backend running DEV_MODE=true, which bypasses auth — `supabase` is null and
 * `isAuthConfigured` is false, so the app skips the login gate entirely and the
 * HTTP layer sends no Authorization header (mirrors the backend's dev bypass).
 *
 *   VITE_SUPABASE_URL       https://<ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY  the project's anon / publishable key
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True only when BOTH credentials are present → production auth is live. */
export const isAuthConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isAuthConfigured
  ? createClient(url as string, anonKey as string, {
      auth: {
        // Persist across reloads (localStorage) and silently refresh the JWT
        // before it expires, so the token injector always reads a live token.
        persistSession: true,
        autoRefreshToken: true,
        // Required for the email-confirmation / magic-link redirect to land a
        // session when the user returns via the link.
        detectSessionInUrl: true,
      },
    })
  : null;
