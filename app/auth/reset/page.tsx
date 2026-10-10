"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPassword() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    setBusy(true);
    const { error } = await createClient().auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message.includes("session") ? "This link has expired. Ask for a new one from the sign-in page." : error.message);
    router.replace("/today");
  }

  return (
    <main className="wrap" style={{ maxWidth: 440, paddingTop: 40 }}>
      <h1>Set a new password</h1>
      <form onSubmit={onSubmit} className="sheet">
        <label htmlFor="password">New password <span className="hint">at least 10 characters</span></label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <div style={{ marginTop: 16 }}><button type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Saving…" : "Save password"}</button></div>
        {error && <p className="notice error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
