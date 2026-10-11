"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Coming back from an email link that couldn't sign you in on this device
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("link") === "expired") {
      setInfo("If you’ve just confirmed your email, sign in below. If you’re resetting your password, request a new link and open it on this device.");
    }
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().auth.signInWithPassword({ email: String(f.get("email")), password: String(f.get("password")) });
    setBusy(false);
    if (error) {
      if (error.message.toLowerCase().includes("confirm")) return setError("Open the confirmation link we emailed you, then sign in.");
      return setError(error.message === "Invalid login credentials" ? "That email and password don’t match. Try again." : error.message);
    }
    router.replace("/today");
    router.refresh();
  }

  async function forgot() {
    const email = (document.getElementById("email") as HTMLInputElement).value.trim();
    if (!email) return setError("Enter your email, then select “Forgot password” again.");
    setError(null);
    const { error } = await createClient().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/confirm?next=/auth/reset` });
    if (error) return setError(error.message);
    setInfo("Check your inbox for a link to reset your password.");
  }

  return (
    <main className="wrap" style={{ maxWidth: 440, paddingTop: 40 }}>
      <Link href="/" className="brand" style={{ fontSize: 26, textDecoration: "none" }}>On<b>Point</b></Link>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit} className="sheet">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
        <button type="button" className="quiet" onClick={forgot} style={{ marginTop: 10, width: "100%" }}>Forgot password</button>
        {error && <p className="notice error" role="alert">{error}</p>}
        {info && <p className="notice ok" role="status">{info}</p>}
      </form>
      <p className="muted">New here? <Link href="/signup">Start free</Link></p>
      <p className="muted small">Staff: use the email address your manager will add to the team.</p>
    </main>
  );
}
