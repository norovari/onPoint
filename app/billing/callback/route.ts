import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { recordCardPayment, verifyTransaction } from "@/lib/paystack";

// Paystack sends the customer back here after paying. We verify with Paystack
// directly (never trusting the URL) and apply the payment. The webhook does the
// same, so whichever arrives first wins and the other is a no-op.
export async function GET(request: NextRequest) {
  const reference = request.nextUrl.searchParams.get("reference") ?? request.nextUrl.searchParams.get("trxref");
  const back = new URL("/billing", request.url);
  if (!reference) return NextResponse.redirect(back);
  try {
    const tx = await verifyTransaction(reference);
    if (tx.status === "success") {
      await recordCardPayment(createServiceClient(), tx);
      back.searchParams.set("paid", "1");
    } else {
      back.searchParams.set("failed", "1");
    }
  } catch (e) {
    console.error("Payment callback", e);
    back.searchParams.set("check", "1");
  }
  return NextResponse.redirect(back);
}
