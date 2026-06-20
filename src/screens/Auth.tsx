import { useState, type InputHTMLAttributes } from "react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/Toast";
import { PrimaryButton, Prompt } from "@/components/wizard";

/**
 * Login / Sign-up — the auth gate's signed-out screen.
 *
 * Matches the log wizards' design contract exactly: pure-black canvas, 390px
 * column, card-grey inputs with a grey focus ring, the `.label` kicker, and the
 * shared <Prompt> heading + <PrimaryButton> CTA. One screen toggles between
 * "Sign in" and "Create account"; errors surface through the shared toast, the
 * email-confirmation hint inline.
 */

type Mode = "signin" | "signup";

export default function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const { show } = useToast();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isSignup = mode === "signup";

  const submit = async () => {
    const e = email.trim();
    if (!e || !password) {
      show("Enter your email and password.");
      return;
    }
    if (password.length < 6) {
      show("Password must be at least 6 characters.");
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      const result = isSignup ? await signUp(e, password) : await signIn(e, password);
      if (result.error) {
        show(result.error);
      } else if (result.needsConfirmation) {
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
        setPassword("");
      }
      // On success the auth listener flips the gate to the app — nothing to do.
    } finally {
      setPending(false);
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "signin" ? "signup" : "signin"));
    setNotice(null);
  };

  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col justify-center gap-8 px-5 pb-5">
      <div className="flex flex-col gap-2">
        <p className="label text-center">VIVID</p>
        <Prompt>{isSignup ? "Create your account" : "Welcome back"}</Prompt>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="you@email.com"
          value={email}
          onChange={setEmail}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center rounded-[14px] border border-card-border bg-card pr-3 focus-within:border-accent">
            <input
              type={reveal ? "text" : "password"}
              autoComplete={isSignup ? "new-password" : "current-password"}
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              className="min-w-0 flex-1 bg-transparent px-4 py-4 text-base text-white outline-none placeholder:text-white/25"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-white/40 active:text-white/70"
            >
              {reveal ? "Hide" : "Show"}
            </button>
          </div>
          {isSignup && (
            <p className="px-1 text-xs text-white/35">At least 6 characters.</p>
          )}
        </div>

        {notice && (
          <p className="rounded-[14px] border border-card-border bg-card px-4 py-3 text-center text-sm font-semibold text-white/80">
            {notice}
          </p>
        )}

        {/* Enter-to-submit while reusing the shared button below. */}
        <button type="submit" className="sr-only" aria-hidden tabIndex={-1} />
        <div className="pt-1">
          <PrimaryButton onClick={submit} disabled={pending}>
            {isSignup ? "Create account" : "Sign in"}
          </PrimaryButton>
        </div>
      </form>

      <p className="text-center text-sm text-white/40">
        {isSignup ? "Already have an account?" : "New to VIVID?"}{" "}
        <button
          type="button"
          onClick={toggleMode}
          className="font-semibold text-white underline-offset-4 active:opacity-70"
        >
          {isSignup ? "Sign in" : "Create an account"}
        </button>
      </p>
    </main>
  );
}

/** A single labelled text field, styled to the app's input contract. */
function Field({
  label,
  value,
  onChange,
  ...input
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="sr-only">{label}</span>
      <input
        {...input}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        className="w-full rounded-[14px] border border-card-border bg-card px-4 py-4 text-base text-white outline-none placeholder:text-white/25 focus:border-accent"
      />
    </label>
  );
}
