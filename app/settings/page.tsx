import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addMember, addProduct, deactivateMember, updateTolerances } from "@/app/actions";
import { formatZar } from "@/lib/calculations";

export const metadata = { title: "Settings" };

export default async function Settings() {
  const s = await requireSession();
  const owner = s.role === "owner";
  const { supabase } = s;

  const [{ data: products }, { data: team }, { data: biz }, { data: sub }] = await Promise.all([
    supabase.from("products").select("id, sku, name, tracking_mode, base_unit, pos_code, active, product_prices(unit_price, valid_from, valid_to)").order("sku"),
    isManager(s.role)
      ? supabase.from("memberships").select("user_id, role, active, profiles(full_name)").eq("business_id", s.businessId)
      : Promise.resolve({ data: [] as never[] }),
    supabase.from("businesses").select("cash_tolerance, stock_tolerance_pct").eq("id", s.businessId).single(),
    owner ? supabase.from("subscriptions").select("plan, status, current_period_end").eq("business_id", s.businessId).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const currentPrice = (p: { product_prices: { unit_price: string; valid_from: string; valid_to: string | null }[] }) =>
    p.product_prices.filter((x) => !x.valid_to).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.unit_price;

  return (
    <Shell businessName={s.businessName}>
      <h1>Settings</h1>

      <h2>Products</h2>
      <p className="muted small">The POS code must match the product code in your POS export so sales can be matched to stock.</p>
      <div className="scroll">
        <table className="data">
          <thead><tr><th>Product</th><th>POS code</th><th>Counted in</th><th className="num">Price</th></tr></thead>
          <tbody>
            {(products ?? []).map((p) => {
              const price = currentPrice(p as never);
              return (
                <tr key={p.id}>
                  <td>{p.name}<br /><span className="muted small">{p.sku}</span></td>
                  <td>{p.pos_code || <span className="muted">not set</span>}</td>
                  <td>{p.base_unit === "g" ? "grams" : "units"}</td>
                  <td className="num">{price === undefined ? "—" : p.base_unit === "g" ? `${formatZar(Number(price) * 1000)}/kg` : formatZar(price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {owner && (
        <ActionForm action={addProduct} className="sheet">
          <h3>Add a product</h3>
          <div className="row">
            <div><label htmlFor="p-sku">SKU</label><input id="p-sku" name="sku" required /></div>
            <div><label htmlFor="p-code">POS code</label><input id="p-code" name="pos_code" /></div>
          </div>
          <label htmlFor="p-name">Name</label>
          <input id="p-name" name="name" required />
          <div className="row">
            <div>
              <label htmlFor="p-mode">Sold</label>
              <select id="p-mode" name="tracking_mode"><option value="unit">By the unit</option><option value="weight">By weight</option></select>
            </div>
            <div><label htmlFor="p-price">Price (R per unit or per kg)</label><input id="p-price" name="price" inputMode="decimal" required /></div>
          </div>
          <div style={{ marginTop: 12 }}><Submit>Add product</Submit></div>
        </ActionForm>
      )}

      {isManager(s.role) && (
        <>
          <h2>Team</h2>
          <ul className="lines">
            {(team ?? []).map((m: { user_id: string; role: string; active: boolean; profiles: unknown }) => (
              <li key={m.user_id} className="line" data-status={m.active ? "matched" : undefined}>
                <span className="name">{(m.profiles as { full_name: string } | null)?.full_name || "Unnamed"}{m.user_id === s.userId ? " (you)" : ""}</span>
                <span className="small muted">{m.active ? m.role : "removed"}</span>
                {owner && m.active && m.user_id !== s.userId && (
                  <span className="meta">
                    <ActionForm action={deactivateMember} hidden={{ user_id: m.user_id }}>
                      <Submit className="quiet">Remove access</Submit>
                    </ActionForm>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {owner && (
            <ActionForm action={addMember} className="sheet">
              <h3>Add a team member</h3>
              <p className="muted small" style={{ marginTop: 0 }}>They need to create an OnPoint account with this email first.</p>
              <div className="row">
                <div><label htmlFor="m-email">Email</label><input id="m-email" name="email" type="email" required /></div>
                <div>
                  <label htmlFor="m-role">Role</label>
                  <select id="m-role" name="role"><option value="staff">Staff</option><option value="manager">Manager</option></select>
                </div>
              </div>
              <div style={{ marginTop: 12 }}><Submit>Add to team</Submit></div>
            </ActionForm>
          )}
        </>
      )}

      {owner && biz && (
        <>
          <h2>When to flag a difference</h2>
          <ActionForm action={updateTolerances} className="sheet">
            <div className="row">
              <div>
                <label htmlFor="t-cash">Cash tolerance (R)</label>
                <input id="t-cash" name="cash_tolerance" type="number" step="0.01" min="0" defaultValue={biz.cash_tolerance} />
              </div>
              <div>
                <label htmlFor="t-stock">Stock tolerance (%)</label>
                <input id="t-stock" name="stock_tolerance_pct" type="number" step="0.001" min="0" defaultValue={biz.stock_tolerance_pct} />
              </div>
            </div>
            <p className="muted small">Zero flags every difference. A small stock tolerance helps with scale rounding on weighed items.</p>
            <Submit>Save tolerances</Submit>
          </ActionForm>
        </>
      )}

      {owner && sub && (
        <>
          <h2>Subscription</h2>
          <p>
            {sub.plan} plan, {sub.status}
            {sub.current_period_end ? ` until ${new Date(sub.current_period_end).toLocaleDateString("en-ZA")}` : ""}.
          </p>
        </>
      )}
    </Shell>
  );
}
