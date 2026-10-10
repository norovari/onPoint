# OnPoint

Shift-based stock, cash and settlement reconciliation for small retailers. OnPoint sits next to the shop's existing POS. It doesn't replace it.

After every shift the owner can see what was recorded, what should be there, what was physically counted or settled, where it differs, and who reviewed it.

**Stack:** Next.js 16 (App Router, TypeScript) on Vercel, with Supabase (Postgres, Auth, Row Level Security) as the database.

---

## What's in this version

| Area | What it does |
| --- | --- |
| Accounts | Email + password sign-up, one-click business creation, owner adds staff/managers by email, deactivate leavers without losing history |
| Opening | Count the float, blind-count opening stock (units or grams), compare with the previous close and flag differences |
| During the shift | Record deliveries, transfers, wastage, damage, internal use, adjustments. Managers import the POS CSV, record cash drops/banking and card/EFT settlements |
| Closing | Blind closing count, cash count, handover checklist and notes, then submit and lock |
| Review | Manager sees every variance with its working, approves staff wastage, then approves or returns the shift with a reason. Recounts are new versions with a reason |
| Exceptions | Register of every difference. Staff explain, managers resolve |
| Reports | Printable shift report (save as PDF from the browser) and CSV export |
| Settings | Products and prices (unit or per-kg), POS code mapping, team, variance tolerances |

**Deliberately not in v1:** replacing the POS, taking payments, payroll, customer marketing, loyalty, delivery, automatic "theft" findings, billing collection. The `subscriptions` and `report_purchases` tables are ready for billing once the workflow is proven.

### Design decisions worth knowing

- **Counts are blind.** Staff never see the expected figure while counting. Showing it invites people to type the number that makes the variance disappear. Differences appear only after submission.
- **Separation of duties.** Whoever opened or closed a shift can't approve it, even if they're a manager (owners can switch this off per business with `allow_self_approval`).
- **Nothing is silently edited.** Counts, movements, cash events, POS lines, settlements, approvals and the audit log are append-only at database level. A recount is version 2 with a reason. A shift or exception can only change state through the workflow functions.
- **Differences, not accusations.** Labels say "variance — review", "awaiting settlement", "missing evidence". A settlement that hasn't arrived is *pending*, never a loss.
- **Customer refunds come through the POS** as negative lines, so there is no separate "customer return" movement (it would double-count).

---

## The formulas

All maths is exact decimal (Postgres `numeric`, `decimal.js` in TypeScript). The database function `public.shift_reconciliation()` is the source of truth. `lib/calculations` mirrors it, and a test proves both agree to the cent and gram.

**Stock, per product**

```
expected closing = opening + deliveries + transfers in ± adjustments
                 − POS net sold − transfers out − wastage − damage − internal use
variance         = counted closing − expected closing
```
Flagged when |variance| > expected × stock tolerance %.

**Cash in the till**

```
expected = opening float + cash sales (after discounts) − cash refunds
         + paid in − paid out − removed to safe − banked
variance = counted − expected
```
Flagged when |variance| > cash tolerance (R).

**Card / EFT settlement, per method**

```
expected net = POS net for that method − processor fees + adjustments
variance     = settled net − expected net
```
No statement yet → *awaiting settlement*.

**Sales cross-check**

```
price difference = Σ(quantity × list price at time of sale) − POS gross for the same lines
```
Catches wrong price mappings or items rung up below list without a discount. Unmapped POS codes are flagged as missing evidence.

### Worked example (used in the tests and the sample CSV)

Opening 100 water, 50 granola bars, 2,500 g tea, 1,000 g nuts. Float R500. Delivery of 20 water. Staff record 2 water as wastage. POS export (`public/sample-pos-export.csv`) has 35 water sold (R360 cash, R270 card), 250 g tea (R112.50 less R2.50 discount, cash), one granola bar refunded in cash (R25), one voided line (ignored), and one unknown code. R300 banked. Closing count 79 water, 51 bars, 2,240 g tea, 1,000 g nuts. Cash counted R650.

| | Expected | Counted | Difference |
| --- | --- | --- | --- |
| Water | 100 + 20 − 35 − 2 = **83** | 79 | **−4** |
| Granola bar | 50 + 1 refunded = **51** | 51 | 0 |
| Tea | 2,500 − 250 = **2,250 g** | 2,240 g | **−10 g** |
| Cash | 500 + 480 − 25 − 300 = **R655** | R650 | **−R5** |
| Card | R270 − R6.75 fees = **R263.25** | R263.25 | matched |

---

## Permissions

Enforced in Postgres with Row Level Security and security-definer functions. The browser only holds the publishable key, so changing a request in the browser can't get around the rules.

| Action | Staff | Manager | Owner |
| --- | --- | --- | --- |
| Open shift, count stock, submit close | ✓ | ✓ | ✓ |
| Record deliveries and transfers in | ✓ | ✓ | ✓ |
| Record wastage, damage, internal use, transfers out, adjustments | needs approval | ✓ | ✓ |
| Import POS data, record cash drops and settlements | | ✓ | ✓ |
| See cash, sales and settlement figures | own shifts only | ✓ | ✓ |
| Approve or return a shift | | ✓ (not own shift) | ✓ (not own shift) |
| Explain an exception | ✓ | ✓ | ✓ |
| Resolve an exception | | ✓ | ✓ |
| See the audit trail | | ✓ | ✓ |
| Products, prices, team, tolerances, subscription | | | ✓ |

Staff see only their own membership. Anonymous visitors see nothing. Businesses are fully isolated from each other.

---

## Set it up

You need: a GitHub account, a Vercel account, a Supabase account, and Node 20+ if you want to run it locally.

### 1. GitHub

```bash
cd onpoint
git init && git add -A && git commit -m "OnPoint MVP"
# create an empty PRIVATE repo called onpoint on github.com, then:
git remote add origin https://github.com/<you>/onpoint.git
git push -u origin main
```

### 2. Supabase

1. Create a project (region: closest to South Africa is fine, e.g. `eu-west` or `af-south` if offered).
2. Run the migrations, either:
   - **SQL Editor:** paste and run each file in `supabase/migrations/` in filename order, or
   - **CLI:** `npx supabase link --project-ref <ref>` then `npx supabase db push`.
3. **Authentication → URL configuration:** set Site URL to your Vercel URL and add `https://<your-app>.vercel.app/auth/confirm` to redirect URLs.
4. **Authentication → Email templates → Confirm signup:** change the link to
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
5. **Project Settings → API:** copy the Project URL and the publishable (anon) key.

### 3. Vercel

1. *Add New → Project*, import the GitHub repo. Framework is detected as Next.js.
2. Add environment variables (Production and Preview):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
3. Deploy. Every push to `main` deploys production. Every other branch gets a preview URL.

Use a separate Supabase project for previews/testing so test shifts never mix with a real shop's records.

### 4. First run

1. Open the site, create an account, set up your shop (tick "add sample products").
2. Open a shift, count, then download `sample-pos-export.csv` from the import screen to try the POS import.
3. To test the manager review properly you need a second account: the person who worked the shift can't approve it.

### Run locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL and key
npm run dev                  # http://localhost:3000
```

---

## Tests

```bash
npm test
```

50 tests run the real migrations inside an in-process Postgres (PGlite), with no cloud project needed:

- **Tenant isolation:** another business sees zero rows in every table and can't call any workflow function on your data. Anonymous users see nothing.
- **Least privilege:** staff money visibility, membership visibility, product/price/subscription protection, deactivated leavers.
- **Full workflow:** open → count → activate → movements → POS import (bad totals rejected, re-import never double-counts) → cash → settlement → close → return → recount v2 → resubmit (old exceptions superseded) → approval blocked until wastage approved → separation of duties → approve → next shift catches the float and stock differences.
- **Append-only evidence and audit trail.**
- **Formulas:** blueprint examples, weight precision, tolerances, refunds, voids, discounts, pending settlements.
- **SQL ↔ TypeScript parity**, including a mid-shift price change.
- **POS CSV validation** with row-numbered errors.

---

## POS import format

One row per sale line:

```
transaction_id,line_no,timestamp,pos_code,quantity,gross_amount,discount_amount,tax_amount,payment_method,line_type
```

- `quantity` in the product's base unit (units, or grams for weighed items)
- `gross_amount` tax-inclusive, before discount
- `payment_method`: `cash` | `card` | `eft` | `other`
- `line_type`: `sale` | `refund` | `void`. Refunds have negative quantity and amount.

**Next step once the pilot store's POS is known:** write a small adapter in `lib/pos/` that converts that POS's export into this format. Nothing else changes.

---

## Before using real shop data

- [ ] Confirm the pilot business's activity and products with a South African lawyer before configuring OnPoint for any regulated sector. The product is deliberately generic.
- [ ] POPIA: agree in writing who is responsible for the personal information (staff names and emails, shift records), how long it's kept, and who can access it.
- [ ] Tell staff in writing what OnPoint records and how differences are reviewed. Take employment advice before using records in any disciplinary process.
- [ ] Move to Supabase Pro (backups; the free tier pauses after a week of inactivity) and test a restore.
- [ ] Turn on leaked-password protection and consider MFA for owners and managers in Supabase Auth.
- [ ] Set the business time zone if not South Africa (`lib/labels.ts` formats in Africa/Johannesburg).
- [ ] Have someone independent review the RLS policies before go-live.

## Project layout

```
app/                    pages and server actions
  actions.ts            every write the app makes (runs as the signed-in user)
  shifts/[id]/          the shift screen: opening, during, closing, review
  reports/[id]/         printable report + CSV
components/             UI pieces (ReconView shows the working for every figure)
lib/calculations/       formulas (mirror of the database engine)
lib/pos/csv.ts          POS export parser and validator
lib/supabase/           server/browser clients
proxy.ts                session refresh + sign-in redirect
supabase/migrations/    schema, security, workflow, onboarding
tests/                  database and formula tests
```
