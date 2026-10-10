"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const supabase = createClient();
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) return setError(error.message === "Invalid login credentials" ? "That email and password don't match an account." : error.message);
      router.replace("/");
      router.refresh();
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: String(f.get("full_name") ?? "") },
          emailRedirectTo: `${window.location.origin}/auth/confirm`,
        },
      });
      setBusy(false);
      if (error) return setError(error.message);
      if (data.session) {
        router.replace("/onboarding");
        router.refresh();
      } else {
        setInfo("Check your email and open the confirmation link to finish creating your account.");
      }
    }
  }

  return (
    <main className="wrap" style={{ maxWidth: 440, paddingTop: 48 }}>
      <p className="brand" style={{ fontSize: 28 }}>
        On<b>Point</b>
      </p>
      <h1>{mode === "signin" ? "Sign in" : "Create your account"}</h1>
      <p className="lede">Count the shift, see what should be there, and know who signed it off.</p>
      <form onSubmit={onSubmit} className="sheet">
        {mode === "signup" && (
          <>
            <label htmlFor="full_name">Your name</label>
            <input id="full_name" name="full_name" autoComplete="name" required />
          </>
        )}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">
          Password {mode === "signup" && <span className="hint">at least 10 characters</span>}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={mode === "signup" ? 10 : undefined}
          required
        />
        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </div>
        {error && <p className="notice error" role="alert">{error}</p>}
        {info && <p className="notice ok" role="status">{info}</p>}
      </form>
      <p className="muted">
        {mode === "signin" ? "New to OnPoint? " : "Already have an account? "}
        <button type="button" className="quiet" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Create an account" : "Sign in instead"}
        </button>
      </p>
      <p className="muted small">
        Staff: ask your manager to add your email to the team after you create your account.
      </p>
    </main>
  );
}
