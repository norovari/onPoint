"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LAUNCH_DISCOUNT, TRIAL_DAYS } from "@/lib/plans";

export default function SignupForm({ businessName }: { businessName: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const business = String(f.get("business")).trim();
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: String(f.get("email")),
      password: String(f.get("password")),
      options: {
        data: { full_name: String(f.get("full_name")).trim(), business_name: business },
        emailRedirectTo: `${window.location.origin}/auth/confirm`,
      },
    });
    if (error) {
      setBusy(false);
      return setError(error.message);
    }
    if (data.session) {
      const { error: bizError } = await supabase.rpc("create_business", { p_name: business, p_location_name: "Main store", p_standard_float: 500 });
      setBusy(false);
      if (bizError) return setError(bizError.message);
      router.replace("/today");
      router.refresh();
    } else {
      setBusy(false);
      setInfo("Check your email and open the confirmation link. Your shop will be ready when you sign in.");
    }
  }

  return (
    <main className="wrap" style={{ maxWidth: 460, paddingTop: 40 }}>
      <Link href="/" className="brand" style={{ fontSize: 26, textDecoration: "none" }}>On<b>Point</b></Link>
      <h1>Start free{businessName ? ` for ${businessName}` : ""}</h1>
      <p className="lede">
        {TRIAL_DAYS} days of everything, no card needed. Subscribe before your trial ends and your first {LAUNCH_DISCOUNT.months} months are {LAUNCH_DISCOUNT.pct}% off.
      </p>
      <form onSubmit={onSubmit} className="sheet">
        <label htmlFor="business">Business name</label>
        <input id="business" name="business" required defaultValue={businessName} maxLength={80} />
        <label htmlFor="full_name">Your name</label>
        <input id="full_name" name="full_name" autoComplete="name" required />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <label htmlFor="password">Password <span className="hint">at least 10 characters</span></label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Creating…" : "Create my account"}</button>
        </div>
        {error && <p className="notice error" role="alert">{error}</p>}
        {info && <p className="notice ok" role="status">{info}</p>}
      </form>
      <p className="muted">Already have an account? <Link href="/login">Sign in</Link></p>
      <p className="muted small">By creating an account you agree to the <Link href="/terms">terms</Link>.</p>
    </main>
  );
}
