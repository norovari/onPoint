import Link from "next/link";
import { CONTACT_EMAIL, LEGAL_NAME } from "@/lib/plans";

export const metadata = { title: "Terms, privacy and refunds" };

// Plain-language starting point. Have a South African attorney review before launch.
export default function Terms() {
  const contact = CONTACT_EMAIL || "the contact address on our pricing page";
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ textDecoration: "none" }}>On<b>Point</b></Link>
      </header>
      <main className="wrap" style={{ maxWidth: 680 }}>
        <h1>Terms, privacy and refunds</h1>
        <p className="lede">OnPoint is a service of {LEGAL_NAME}. By creating an account you agree to these terms.</p>

        <h2>What OnPoint is</h2>
        <p>OnPoint is software for recording stock counts, stock movements, sales totals and cash, and showing where they don’t match. It does not sell, buy, deliver or process payment for any product on your behalf. You are responsible for running your business lawfully and for the accuracy of what you enter.</p>
        <p>A difference shown by OnPoint is something to look into. It is not proof that anyone did anything wrong. Take your own advice before acting on it, especially in any staff matter.</p>

        <h2>Plans and payment</h2>
        <p>New accounts get a free trial. After it ends, the account moves to the Free plan unless you choose a paid plan. Paid plans are billed monthly in advance by card, through PayFast. Each account has its own reference number (starting NY0R0), shown on every payment. Payments renew automatically each month until you cancel. The launch discount applies to the first three monthly payments when you subscribe within 5 days of creating your account (the 3-day trial plus 2 days).</p>
        <p>If a card payment fails, you have 7 days to update your payment before the account moves to the Free plan. Your records are kept.</p>

        <h2>Cancelling and refunds</h2>
        <p>You can cancel any time by contacting us at {contact}. Your plan stays active until the end of the month you paid for, and you won’t be charged again. Because each month is paid in advance and the service is available immediately, we don’t refund part-months. If you were charged in error, contact us within 30 days and we will refund it.</p>

        <h2>Your data</h2>
        <p>Your stock, sales, cash and staff records belong to you. Only people you add to your team can see them in OnPoint. Our admin view shows your business name, contact email, plan, payments and activity counts (such as shifts closed and number of open alerts). It does not show your figures.</p>
        <p>We process personal information (names and email addresses of you and your staff, and records of who did what in each shift) only to provide the service, in line with the Protection of Personal Information Act. We don’t sell it or use it for marketing. Data is hosted with our cloud providers and backed up. Ask us to export or delete your data at any time.</p>
        <p>To improve the website we count page visits without cookies (Vercel Web Analytics), and we note when a personal demo link is opened and which parts of the demo are used. This doesn’t identify you personally.</p>
        <p>Tell your staff that OnPoint records their counts and actions. Card details are handled by our payment provider; OnPoint never sees or stores card numbers.</p>

        <h2>Availability</h2>
        <p>We work to keep OnPoint available and your data safe, but can’t promise it will never be interrupted. Our liability is limited to the amount you paid us in the three months before a claim.</p>

        <h2>Contact</h2>
        <p>{LEGAL_NAME}{CONTACT_EMAIL ? `, ${CONTACT_EMAIL}` : ""}.</p>
      </main>
    </>
  );
}
