# OnPoint

Stock and cash control for dispensaries. After every shift the owner sees, in plain words, whether stock and money tally. Every alert has to be fixed or explained before it closes.

Run by **Norovari (Pty) Ltd t/a OnPoint**.

## What's in it

**Public, no sign-up**
- **Front page (`/`):** a dispensary types its name and gets a demo shift with its own name on it (`/demo`).
- **Pricing (`/pricing`) and terms, privacy and refunds (`/terms`):** Paystack needs both pages before approving an account.

**For each dispensary**
- **Sign up with the business name:** they get a 14-day Business-plan trial with no card. The 24-hour launch offer gives 20% off the first 3 monthly payments.
- **Staff:** blind opening and closing counts, cash count, card machine total, deliveries and wastage, specials sold.
- **Managers:** import the till file, or type in the till's end-of-day report, then approve or return the shift.
- **Owner screens for every shift:**
  - Alerts
  - Today's specials
  - Last shift stock
  - In stock now
  - What each product made
  - Stock for next shift
- **Alerts:** stock and money don't tally (valued at selling price), cash short, card machine doesn't match, a special gives away extra items, a product went into minus, running low. They show in the app on every plan, and are emailed on paid plans once email is set up.
- **Monthly report (Business plan and up):** what goes missing most, and on whose shifts.
- **Plan page:** pay by card (Paystack, renews monthly) or EFT invoice.

**For you (`/admin`)**
- Only a confirmed sign-in as **nyorovai@gmail.com** opens it. Everyone else gets "not found". This is checked in the database, not just the page.
- Shows every dispensary, its plan, trial end, payments, team size, shifts closed and the number of open alerts. It never shows their stock, sales or cash.
- **Mark paid:** for EFT invoices, after you see the reference on your bank statement.
- **Change plan by hand:** extend trials or give free months.

**Plans** (prices are set in `lib/plans.ts` and in `private.plan_price` in the database; change both together)

| Plan | Price | Includes |
| --- | --- | --- |
| Free | R0 | 1 shop, 15 products, alerts in the app, 7 days of history |
| Starter | R299 | Unlimited products, email alerts, specials, 90 days of history |
| Business | R699 | Monthly report, comparison with a usual day, full history |
| Multi-site | R1,499 | More than one shop |

These limits are enforced in the database, not only hidden in the app.

## Go live: step by step

### 1. Supabase (database and logins)
1. Create a project at supabase.com, in the region closest to South Africa.
2. In **SQL Editor**, paste and run `supabase/setup/1-run-first.sql`, then in a new query `supabase/setup/2-run-second.sql`. These two files are the migrations combined. Alternatively, use the CLI: `npx supabase link` then `npx supabase db push`.
3. **Authentication → Sign In / Providers → Email:** keep "Confirm email" **on**. Admin access depends on a confirmed email.
4. **Authentication → URL Configuration:** set Site URL to your domain, and add `https://<domain>/auth/confirm` and `https://<domain>/auth/reset` to the redirect URLs.
5. **Authentication → Email templates:**
   - Confirm signup: link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
   - Reset password: link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`
6. Copy the Project URL, the publishable key and the **secret** key from Project Settings → API Keys.
7. Move to the Pro plan before real customers arrive. You need backups, and the free tier pauses when it's idle.

### 2. GitHub
```bash
cd onpoint
git remote add origin https://github.com/<you>/onpoint.git   # create an empty PRIVATE repo first
git push -u origin main
```

### 3. Vercel (hosting)
1. Import the GitHub repo.
2. Add every variable from `.env.example`. The secret key, Paystack key and CRON_SECRET are server-only: never prefix them with `NEXT_PUBLIC_`.
3. Deploy, then add your domain under Settings → Domains.
4. The daily card-renewal job in `vercel.json` runs at 08:00 South African time.

### 4. Your admin login
Sign up on the live site with **nyorovai@gmail.com**, confirm the email, then sign in. The **Admin** tab appears. Use a new password, not one that has been written down or shared, and turn on two-factor authentication for that account in Supabase when you can.

### 5. Getting paid
- **EFT (works from day one):** fill in the four `EFT_` variables with the Norovari (Pty) Ltd business account. Clubs get an invoice with a unique reference. When the money arrives, open Admin and tap **Mark paid**.
- **Card (Paystack):** open a Paystack account for **Norovari (Pty) Ltd**, separate from Norovari Tours. Describe OnPoint honestly as stock-control software for retailers, with dispensaries as your first customers. Once approved:
  - put the live secret key in `PAYSTACK_SECRET_KEY`
  - set the webhook URL to `https://<domain>/api/paystack/webhook`
  - the "Pay by card" buttons appear automatically

  Renewals charge the saved card token monthly. If a payment fails, the club gets 7 days' grace and then moves to Free.

### 6. Email alerts
Create a free Resend account and verify your domain. Then set `RESEND_API_KEY` and `ALERT_FROM_EMAIL`. Alerts never mention product names, only the business name, the number of problems and a link.

### 7. Before you sign the first paying club
- [ ] Have an attorney review `/terms` and take advice on supplying software to cannabis businesses.
- [ ] Check that "OnPoint" is free to use: the domain, plus a CIPC trademark search in the software class.
- [ ] Register a POPIA Information Officer for Norovari (Pty) Ltd.

## Till files
CSV, one row per sale line:
```
transaction_id,line_no,timestamp,pos_code,quantity,gross_amount,discount_amount,tax_amount,payment_method,line_type[,special_code,deal_ref]
```
- `special_code` matches the till code set on the special.
- `deal_ref` groups the lines of one deal, so specials are counted automatically.

Without a till file, managers can type in the till report instead, and staff can record specials by hand.

## Tests
`npm test` runs 61 tests against the real migrations in an in-process Postgres. They cover:
- tenant isolation
- the admin gate, including a look-alike unconfirmed email
- billing: the 24-hour discount over 3 months, duplicate callbacks, wrong amounts, EFT, failed renewals and grace
- plan limits
- the specials tally, minus and low-stock alerts, till and card-machine totals
- the full shift workflow
- SQL vs TypeScript sums

## Project layout
```
app/                 pages and server actions (app/actions.ts)
  page.tsx           front page        demo/        open demo
  today/ shifts/ exceptions/ settings/ billing/ reports/ admin/
  api/paystack/webhook   api/cron/billing
components/          OwnerShiftView (the six owner screens), forms
lib/                 plans.ts, paystack.ts, notify.ts, calculations, supabase clients
supabase/migrations/ schema, security, workflow, billing, specials
tests/               database and formula tests
```
