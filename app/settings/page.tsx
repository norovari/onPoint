import { requireSession, isManager } from "@/lib/supabase/server";
import { Shell } from "@/components/Shell";
import { ActionForm, Submit } from "@/components/ActionForm";
import { addMember, addProduct, addSpecial, deactivateMember, setCountSettings, setProductOptions, setRequireStatement, setSalesSource, toggleSpecial, updateTolerances } from "@/app/actions";
import { formatZar } from "@/lib/calculations";
import { ProductImport } from "@/components/ProductImport";
import { CATEGORIES } from "@/lib/products/import";

export const metadata = { title: "Settings" };

function optionSummary(p: { always_count: boolean; low_stock_level: string | null; allowance_pct: string | null; container_weight: string | null }) {
  return [
    p.always_count && "check every shift",
    p.low_stock_level !== null && `warn me below ${Number(p.low_stock_level)}`,
    p.allowance_pct !== null && Number(p.allowance_pct) > 0 && `${Number(p.allowance_pct)}% extra allowed`,
    p.container_weight !== null && Number(p.container_weight) > 0 && `empty jar ${Number(p.container_weight)} g`,
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
    supabase.from("businesses").select("cash_tolerance, stock_tolerance_pct, sales_source, count_mode, spot_per_shift, full_count_days, require_statement").eq("id", s.businessId).single(),
    owner ? supabase.from("subscriptions").select("plan, status, current_period_end").eq("business_id", s.businessId).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const currentPrice = (p: { product_prices: { unit_price: string; valid_from: string; valid_to: string | null }[] }) =>
    p.product_prices.filter((x) => !x.valid_to).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.unit_price;

  return (
    <Shell businessName={s.businessName}>
      <h1>Settings</h1>

      <h2>Products</h2>
      <p className="muted small">Your product list. When you upload till sales, OnPoint matches the till items to these products.</p>
      <div className="scroll">
        <table className="data">
          <thead><tr><th>Product</th><th>Category</th><th>Sold by</th><th className="num">Price</th><th>Stock checks</th></tr></thead>
          <tbody>
            {(products ?? []).map((p) => {
              const price = currentPrice(p as never);
              return (
                <tr key={p.id}>
                  <td>{p.name}<br /><span className="muted small">{p.sku}</span></td>
                  <td>{p.category || <span className="muted">none</span>}</td>
                  <td>{p.base_unit === "g" ? "gram" : "unit"}</td>
                  <td className="num">{price === undefined ? "—" : p.base_unit === "g" ? `${formatZar(price)}/g` : formatZar(price)}</td>
                  <td>
                    <span className="small">{optionSummary(p) || <span className="muted">Default</span>}</span>
                    {owner && (
                      <details>
                        <summary className="small">Edit</summary>
                        <ActionForm action={setProductOptions} hidden={{ product_id: p.id }}>
                          <label className="check" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                            <input type="checkbox" name="always_count" defaultChecked={p.always_count} style={{ width: "auto" }} /> Check every shift
                          </label>
                          <label htmlFor={`low-${p.id}`}>Warn me when stock is low (below)</label>
                          <input id={`low-${p.id}`} name="low_stock_level" inputMode="decimal" defaultValue={p.low_stock_level ?? ""} style={{ width: 100 }} />
                          {p.base_unit === "g" && (
                            <>
                              <label htmlFor={`alw-${p.id}`}>Extra allowed per bag (%) <span className="hint">For example, 10% allows 2.2 g in a 2 g bag.</span></label>
                              <input id={`alw-${p.id}`} name="allowance_pct" inputMode="decimal" defaultValue={p.allowance_pct ?? ""} style={{ width: 100 }} />
                              <label htmlFor={`jar-${p.id}`}>Empty jar weight (g) <span className="hint">OnPoint subtracts this from the full jar reading.</span></label>
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
            <div><label htmlFor="p-sku">Product code</label><input id="p-sku" name="sku" required /></div>
            <div><label htmlFor="p-code">Till code</label><input id="p-code" name="pos_code" /></div>
          </div>
          <label htmlFor="p-name">Name</label>
          <input id="p-name" name="name" required />
          <label htmlFor="p-cat">Category</label>
          <input id="p-cat" name="category" list="p-cats" placeholder="Flower, Pre-rolls, Edibles…" />
          <datalist id="p-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="row">
            <div>
              <label htmlFor="p-mode">Sold by</label>
              <select id="p-mode" name="tracking_mode"><option value="unit">Unit</option><option value="weight">Gram</option></select>
            </div>
            <div><label htmlFor="p-price">Price (R per unit or gram)</label><input id="p-price" name="price" inputMode="decimal" required /></div>
          </div>
          <div style={{ marginTop: 12 }}><Submit>Add product</Submit></div>
        </ActionForm>
      )}


      <h2>Specials</h2>
      <p className="muted small">Set up your deals once. For example, “Any 2 indoor pre-rolls for R200”. OnPoint tracks each deal, including the items sold and the discount.</p>
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
          <label htmlFor="sp-code">Till code <span className="hint">optional</span></label>
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
              <h3>Add team member</h3>
              <p className="muted small" style={{ marginTop: 0 }}>Each team member must create an OnPoint account using their own email first.</p>
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
          <h2>Where your sales come from</h2>
          <ActionForm action={setSalesSource} className="sheet">
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input type="radio" name="sales_source" value="till" defaultChecked={biz.sales_source !== "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>From your till.</strong> Upload the till’s sales report or enter its end-of-day totals. This gives you more detail about which products are short.</span>
            </label>
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginTop: 10 }}>
              <input type="radio" name="sales_source" value="counts" defaultChecked={biz.sales_source === "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>From stock counts.</strong> No till file needed. OnPoint estimates what left the shelf and checks it against the cash and card totals.</span>
            </label>
            <div style={{ marginTop: 12 }}><Submit>Save</Submit></div>
          </ActionForm>

          <h2>Stock checks</h2>
          <ActionForm action={setCountSettings} className="sheet">
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input type="radio" name="count_mode" value="full" defaultChecked={biz.count_mode !== "spot"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Count everything.</strong> Check every product at every close. Best for a small menu.</span>
            </label>
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, marginTop: 10 }}>
              <input type="radio" name="count_mode" value="spot" defaultChecked={biz.count_mode === "spot"} disabled={biz.sales_source === "counts"} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Spot-check products.</strong> OnPoint chooses products to check each shift. Other stock carries forward from recorded sales. Cash is still checked every shift.{biz.sales_source === "counts" && <><br /><span className="muted">To work out sales from stock counts, you must count all stock at each close.</span></>}</span>
            </label>
            <div className="row" style={{ marginTop: 10 }}>
              <div><label htmlFor="c-per">Products to check per shift</label><input id="c-per" name="spot_per_shift" type="number" min="3" max="200" defaultValue={biz.spot_per_shift ?? 12} /></div>
              <div><label htmlFor="c-days">Check every product at least every … days</label><input id="c-days" name="full_count_days" type="number" min="1" max="60" defaultValue={biz.full_count_days ?? 7} /></div>
            </div>
            <div style={{ marginTop: 12 }}><Submit>Save</Submit></div>
          </ActionForm>

          <h2>Shift questions</h2>
          <ActionForm action={setRequireStatement} className="sheet">
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400 }}>
              <input type="checkbox" name="require_statement" defaultChecked={biz.require_statement !== false} style={{ width: "auto", marginTop: 4 }} />
              <span><strong>Ask staff the three shift questions at close.</strong> Each person explains anything not recorded, reports stock problems, adds notes and photos, and confirms with their own PIN or password. Answers appear in the shift report and nightly email.</span>
            </label>
            <div style={{ marginTop: 12 }}><Submit>Save</Submit></div>
          </ActionForm>

          <h2>Differences to flag</h2>
          <ActionForm action={updateTolerances} className="sheet">
            <div className="row">
              <div>
                <label htmlFor="t-cash">Ignore cash differences up to (R)</label>
                <input id="t-cash" name="cash_tolerance" type="number" step="0.01" min="0" defaultValue={biz.cash_tolerance} />
              </div>
              <div>
                <label htmlFor="t-stock">Ignore stock differences up to (%)</label>
                <input id="t-stock" name="stock_tolerance_pct" type="number" step="0.001" min="0" defaultValue={biz.stock_tolerance_pct} />
              </div>
            </div>
            <p className="muted small">Zero flags every difference. A small stock tolerance helps with scale rounding on weighed items.</p>
            <Submit>Save</Submit>
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
