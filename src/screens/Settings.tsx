import { useAuth } from "@/context/AuthContext";
import { isAuthConfigured } from "@/lib/supabase";

/**
 * Settings — currently the home for the signed-in identity + sign-out, closing
 * the auth loop. The remaining settings (pillars, habits, budget, bodyweight
 * goal, units, export, account deletion) land in build step 14. On-brand: pure
 * black, grey chrome, the secondary card-button treatment for sign-out.
 */
export default function Settings() {
  const { email, signOut } = useAuth();

  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header>
        <p className="label">VIVID</p>
        <h1 className="text-2xl font-extrabold tracking-tight">Settings</h1>
      </header>

      {isAuthConfigured && (
        <section className="mt-6 flex flex-col gap-3">
          <div className="rounded-[14px] border border-card-border bg-card p-4">
            <p className="label mb-1">Signed in as</p>
            <p className="break-all text-sm font-semibold text-white/80">{email ?? "—"}</p>
          </div>
        </section>
      )}

      <p className="mt-6 max-w-[280px] text-sm text-white/40">
        Pillars, habits, budget, bodyweight goal, units, export and account deletion arrive in build
        step 14.
      </p>

      {isAuthConfigured && (
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-auto h-14 rounded-[14px] border border-card-border bg-card text-base font-semibold text-white/80 active:bg-white/10"
        >
          Sign out
        </button>
      )}
    </main>
  );
}
