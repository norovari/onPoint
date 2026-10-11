import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addMember, addProduct, addSpecial, deactivateMember, setLowStock, setSalesSource, toggleSpecial, updateTolerances } from "@/app/actions";
import { formatZar } from "@/lib/calculations";

export const metadata = { title: "Settings" };

export default async function Settings() {
  const s = await requireSession();
  const owner = s.role === "owner";
  const { supabase } = s;

  const { data: specials } = await supabase.from("specials").select("id, name, code, deal_price, items_per_deal, active, special_products(product_id)").order("name");
  const [{ data: products }, { data: team }, { data: biz }, { data: sub }] = await Promise.all([
    supabase.from("products").select("id, sku, name, tracking_mode, base_unit, pos_code, active, low_stock_level, product_prices(unit_price, valid_from, valid_to)").order("sku"),
    isManager(s.role)
      ? supabase.from("memberships").select("user_id, role, active, profiles(full_name)").eq("business_id", s.businessId)
      : Promise.resolve({ data: [] as never[] }),
    supabase.from("businesses").select("cash_tolerance, stock_tolerance_pct, sales_source").eq("id", s.businessId).single(),
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
          <thead><tr><th>Product</th><th>POS code</th><th>Counted in</th><th className="num">Price</th><th>Warn when below</th></tr></thead>
          <tbody>
            {(products ?? []).map((p) => {
              const price = currentPrice(p as never);
              return (
                <tr key={p.id}>
                  <td>{p.name}<br /><span className="muted small">{p.sku}</span></td>
                  <td>{p.pos_code || <span className="muted">not set</span>}</td>
                  <td>{p.base_unit === "g" ? "grams" : "units"}</td>
                  <td className="num">{price === undefined ? "—" : p.base_unit === "g" ? `${formatZar(Number(price) * 1000)}/kg` : formatZar(price)}</td>
                  <td>
                    {owner ? (
                      <ActionForm action={setLowStock} hidden={{ product_id: p.id }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input name="low_stock_level" aria-label={`Warn when ${p.name} is below`} inputMode="decimal" defaultValue={p.low_stock_level ?? ""} style={{ width: 80, padding: "6px 8px" }} />
                          <Submit className="quiet">Save</Submit>
                        </div>
                      </ActionForm>
                    ) : (p.low_stock_level ?? "—")}
                  </td>
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


      <h2>Specials</h2>
      <p className="muted small">Set up your deals once (for example “Any 2 indoor pre-rolls for R200”). OnPoint tallies each one on its own: deals sold, the mix people chose, the discount, and any extra items that went out.</p>
      {(specials ?? []).length > 0 && (
        <ul className="lines">
          {(specials ?? []).map((sp) => (
            <li key={sp.id} className="line" data-status={sp.active ? "matched" : undefined}>
              <span className="name">{sp.name}</span>
              <span className="small muted">{formatZar(sp.deal_price)} for {sp.items_per_deal}</span>
              <span className="meta">
                {(sp.special_products as { product_id: string }[]).map((x) => (products ?? []).find((p) => p.id === x.product_id)?.name).filter(Boolean).join(", ")}
                {sp.code ? `. Till code ${sp.code}` : ""}
                {owner && (
                  <ActionForm action={toggleSpecial} hidden={{ special_id: sp.id, active: String(!sp.active) }}>
                    <Submit className="quiet">{sp.active ? "Switch off" : "Switch on"}</Submit>
                  </ActionForm>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {owner && (
        <ActionForm action={addSpecial} className="sheet">
          <h3>Add a special</h3>
          <label htmlFor="sp-name">Name</label>
          <input id="sp-name" name="name" placeholder="Any 2 indoor pre-rolls for R200" required />
          <div className="row">
            <div><label htmlFor="sp-price">Deal price (R)</label><input id="sp-price" name="deal_price" inputMode="decimal" required /></div>
            <div><label htmlFor="sp-per">Items per deal</label><input id="sp-per" name="items_per_deal" type="number" min="1" step="1" defaultValue="2" required /></div>
          </div>
          <label htmlFor="sp-code">Till code <span className="hint">optional: how the deal appears in your till export</span></label>
          <input id="sp-code" name="code" />
          <p style={{ fontWeight: 700, fontSize: 15, margin: "12px 0 4px" }}>Customers can choose from</p>
          {(products ?? []).filter((p) => p.active).map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 400, margin: "4px 0" }}>
              <input type="checkbox" name="product_ids" value={p.id} style={{ width: "auto" }} /> {p.name}
            </label>
          ))}
          <div style={{ marginTop: 12 }}><Submit>Add special</Submit></div>
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
          <h2>How sales get into OnPoint</h2>
          <ActionForm action={setSalesSource} className="sheet">
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input type="radio" name="sales_source" value="till" defaultChecked={biz.sales_source !== "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>From our till.</strong> Each shift, upload the till’s sales export (any layout, CSV or Excel) or type in its end-of-day report. Most detailed: shows exactly which product is short.</span>
            </label>
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginTop: 10 }}>
              <input type="radio" name="sales_source" value="counts" defaultChecked={biz.sales_source === "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Work it out from our counts.</strong> No till file needed. At close, OnPoint prices the stock that left the shelf and checks it against the cash and card you count, so you still see if money is missing.</span>
            </label>
            <div style={{ marginTop: 12 }}><Submit>Save</Submit></div>
          </ActionForm>

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
          <h2>Plan</h2>
          <p><a href="/billing">See your plan and payments</a></p>
        </>
      )}
    </Shell>
  );
}
