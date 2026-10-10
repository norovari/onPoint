import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, Submit } from "@/components/ActionForm";
import { createBusiness } from "@/app/actions";

export const metadata = { title: "Set up your shop" };

export default async function Onboarding() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const { data: m } = await supabase.from("memberships").select("business_id").eq("user_id", data.user.id).eq("active", true).limit(1);
  if (m?.length) redirect("/");

  return (
    <main className="wrap" style={{ maxWidth: 520, paddingTop: 32 }}>
      <p className="brand">On<b>Point</b></p>
      <h1>Set up your shop</h1>
      <p className="lede">
        If you work for a shop that already uses OnPoint, ask the owner to add {data.user.email} to their team instead.
      </p>
      <ActionForm action={createBusiness} className="sheet">
        <label htmlFor="full_name">Your name</label>
        <input id="full_name" name="full_name" autoComplete="name" />
        <label htmlFor="name">Business name</label>
        <input id="name" name="name" required />
        <label htmlFor="location">Shop location <span className="hint">e.g. Main store</span></label>
        <input id="location" name="location" required />
        <label htmlFor="float">Standard till float (R)</label>
        <input id="float" name="float" type="number" inputMode="decimal" step="0.01" min="0" defaultValue="500" />
        <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 400 }}>
          <input type="checkbox" name="demo" defaultChecked style={{ width: "auto" }} />
          Add four sample products so I can try a shift first
        </label>
        <div style={{ marginTop: 16 }}>
          <Submit>Create my shop</Submit>
        </div>
      </ActionForm>
    </main>
  );
}
