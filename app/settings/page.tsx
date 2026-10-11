import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addMember, addProduct, addSpecial, deactivateMember, setCountSettings, setProductOptions, setSalesSource, toggleSpecial, updateTolerances } from "@/app/actions";
import { formatZar } from "@/lib/calculations";
import { ProductImport } from "@/components/ProductImport";
import { CATEGORIES } from "@/lib/products/import";

export const metadata = { title: "Settings" };

function optionSummary(p: { always_count: boolean; low_stock_level: string | null; allowance_pct: string | null; container_weight: string | null }) {
  return [
    p.always_count && "every shift",
    p.low_stock_level !== null && `warn below ${Number(p.low_stock_level)}`,
    p.allowance_pct !== null && Number(p.allowance_pct) > 0 && `${Number(p.allowance_pct)}% allowance`,
    p.container_weight !== null && Number(p.container_weight) > 0 && `jar ${Number(p.container_weight)}g`,
  ].filter(Boolean).join(", ");
}

export default async function Settings() {
  const s = await requireSession();
  const owner = s.role === "owner";
  const { supabase } = s;

  const { data: specials } = await supabase.from("specials").select("id, name, code, deal_price, items_per_deal, active, special_products(product_id)").order("name");
  const [{ data: products }, { data: team }, { data: biz }, { data: sub }] = await Promise.all([
    supabase.from("products").select("id, sku, name, tracking_mode, base_unit, pos_code, category, active, low_stock_level, always_count, allowance_pct, container_weight, product_prices(unit_price, valid_from, valid_to)").order("category").order("name"),
    isManager(s.role)
      ? supabase.from("memberships").select("user_id, role, active, profiles(full_name)").eq("business_id", s.businessId)
      : Promise.resolve({ data: [] as never[] }),
    supabase.from("businesses").select("cash_tolerance, stock_tolerance_pct, sales_source, count_mode, spot_per_shift, full_count_days").eq("id", s.businessId).single(),
    owner ? supabase.from("subscriptions").select("plan, status, current_period_end").eq("business_id", s.businessId).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const currentPrice = (p: { product_prices: { unit_price: string; valid_from: string; valid_to: string | null }[] }) =>
    p.product_prices.filter((x) => !x.valid_to).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.unit_price;

  return (
    <Shell businessName={s.businessName}>
      <h1>Settings</h1>

      <h2>Products</h2>
      <p className="muted small">Your menu. Till items are linked to these products the first time you upload a till file.</p>
      <div className="scroll">
        <table className="data">
          <thead><tr><th>Product</th><th>Category</th><th>Counted in</th><th className="num">Price</th><th>Counting</th></tr></thead>
          <tbody>
            {(products ?? []).map((p) => {
              const price = currentPrice(p as never);
              return (
                <tr key={p.id}>
                  <td>{p.name}<br /><span className="muted small">{p.sku}</span></td>
                  <td>{p.category || <span className="muted">none</span>}</td>
                  <td>{p.base_unit === "g" ? "grams" : "units"}</td>
                  <td className="num">{price === undefined ? "—" : p.base_unit === "g" ? `${formatZar(price)}/g` : formatZar(price)}</td>
                  <td>
                    <span className="small">{optionSummary(p) || <span className="muted">standard</span>}</span>
                    {owner && (
                      <details>
                        <summary className="small">Change</summary>
                        <ActionForm action={setProductOptions} hidden={{ product_id: p.id }}>
                          <label className="check" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                            <input type="checkbox" name="always_count" defaultChecked={p.always_count} style={{ width: "auto" }} /> Count every shift
                          </label>
                          <label htmlFor={`low-${p.id}`}>Warn when below</label>
                          <input id={`low-${p.id}`} name="low_stock_level" inputMode="decimal" defaultValue={p.low_stock_level ?? ""} style={{ width: 100 }} />
                          {p.base_unit === "g" && (
                            <>
                              <label htmlFor={`alw-${p.id}`}>Allowance on sales, % <span className="hint">extra you’re happy to give, e.g. 10 = 2.2g on a 2g bag</span></label>
                              <input id={`alw-${p.id}`} name="allowance_pct" inputMode="decimal" defaultValue={p.allowance_pct ?? ""} style={{ width: 100 }} />
                              <label htmlFor={`jar-${p.id}`}>Empty jar, grams <span className="hint">staff weigh the whole jar; this is taken off</span></label>
                              <input id={`jar-${p.id}`} name="container_weight" inputMode="decimal" defaultValue={p.container_weight ?? ""} style={{ width: 100 }} />
                            </>
                          )}
                          <div style={{ marginTop: 8 }}><Submit className="quiet">Save</Submit></div>
                        </ActionForm>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {owner && <ProductImport existing={(products ?? []).map((p) => ({ name: p.name, sku: p.sku }))} />}

      {owner && (
        <ActionForm action={addProduct} className="sheet">
          <h3>Add a product</h3>
          <div className="row">
            <div><label htmlFor="p-sku">SKU</label><input id="p-sku" name="sku" required /></div>
            <div><label htmlFor="p-code">POS code</label><input id="p-code" name="pos_code" /></div>
          </div>
          <label htmlFor="p-name">Name</label>
          <input id="p-name" name="name" required />
          <label htmlFor="p-cat">Category</label>
          <input id="p-cat" name="category" list="p-cats" placeholder="Flower, Pre-rolls, Edibles…" />
          <datalist id="p-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="row">
            <div>
              <label htmlFor="p-mode">Sold</label>
              <select id="p-mode" name="tracking_mode"><option value="unit">By the unit</option><option value="weight">By the gram</option></select>
            </div>
            <div><label htmlFor="p-price">Price (R per unit, or per gram)</label><input id="p-price" name="price" inputMode="decimal" required /></div>
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

          <h2>How you count stock</h2>
          <ActionForm action={setCountSettings} className="sheet">
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input type="radio" name="count_mode" value="full" defaultChecked={biz.count_mode !== "spot"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Count everything at every close.</strong> Best for a small menu.</span>
            </label>
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginTop: 10 }}>
              <input type="radio" name="count_mode" value="spot" defaultChecked={biz.count_mode === "spot"} disabled={biz.sales_source === "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Spot-check a few products each shift.</strong> OnPoint picks the list: some at random, ones that didn’t tally recently, and ones not checked for a while. Everything else carries forward from the till sales. Cash is still checked every shift.{biz.sales_source === "counts" && <><br /><span className="muted">Needs till sales: without a till file the full count is how sales are worked out.</span></>}</span>
            </label>
            <div className="row" style={{ marginTop: 10 }}>
              <div><label htmlFor="c-per">Products per shift</label><input id="c-per" name="spot_per_shift" type="number" min="3" max="200" defaultValue={biz.spot_per_shift ?? 12} /></div>
              <div><label htmlFor="c-days">Check every product at least every … days</label><input id="c-days" name="full_count_days" type="number" min="1" max="60" defaultValue={biz.full_count_days ?? 7} /></div>
            </div>
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
