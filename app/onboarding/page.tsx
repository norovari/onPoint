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
  if (m?.length) redirect("/today");

  return (
    <main className="wrap" style={{ maxWidth: 520, paddingTop: 32 }}>
      <p className="brand">On<b>Point</b></p>
      <h1>Set up your shop</h1>
      <p className="lede">
        Already work at a shop using OnPoint? Ask the owner to add {data.user.email} to the team instead.
      </p>
      <ActionForm action={createBusiness} className="sheet">
        <label htmlFor="full_name">Your name</label>
        <input id="full_name" name="full_name" autoComplete="name" defaultValue={String(data.user.user_metadata?.full_name ?? "")} />
        <label htmlFor="name">Business name</label>
        <input id="name" name="name" required defaultValue={String(data.user.user_metadata?.business_name ?? "")} />
        <label htmlFor="location">Shop name or area <span className="hint">e.g. Main store</span></label>
        <input id="location" name="location" required defaultValue="Main store" />
        <label htmlFor="float">Starting cash float (R) <span className="hint">the cash you keep in the till at the beginning of a shift</span></label>
        <input id="float" name="float" type="number" inputMode="decimal" step="0.01" min="0" defaultValue="500" />
        <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 400 }}>
          <input type="checkbox" name="demo" defaultChecked style={{ width: "auto" }} />
          Add sample products to try a shift first. You can edit or remove them later.
        </label>
        <div style={{ marginTop: 16 }}>
          <Submit>Create my shop</Submit>
        </div>
      </ActionForm>
    </main>
  );
}
