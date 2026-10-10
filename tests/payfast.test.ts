import { describe, expect, test } from "vitest";
import { apiSignature, formSignature, orderedFormFields, phpUrlencode, validItnSignature } from "@/lib/payfast-core";

// Expected values were computed with PHP's urlencode()/md5() exactly as PayFast's
// own SDK (payfast-php-sdk) does, so these prove the TypeScript port matches.
const PASS = "jt7NOE43FZPn";

describe("PayFast signatures", () => {
  test("urlencode matches PHP", () => {
    expect(phpUrlencode("Nature's Nook · NY0R02192")).toBe("Nature%27s+Nook+%C2%B7+NY0R02192");
    expect(phpUrlencode("a~b!c*(d)")).toBe("a%7Eb%21c%2A%28d%29");
  });

  test("checkout form signature", () => {
    const fields = {
      // deliberately out of order: the signature must use PayFast's order
      subscription_type: "2", payment_method: "cc", custom_str1: "NY0R02192",
      merchant_id: "10000100", merchant_key: "46f0cd694581a",
      return_url: "https://on-point-b9ap.vercel.app/billing?check=1",
      cancel_url: "https://on-point-b9ap.vercel.app/billing?cancelled=1",
      notify_url: "https://on-point-b9ap.vercel.app/api/payfast/notify",
      name_first: "Dee O'Neil", email_address: "owner+test@example.co.za",
      m_payment_id: "NY0R02192-01", amount: "239.20", item_name: "OnPoint Starter (monthly)",
      item_description: "Nature's Nook · NY0R02192", name_last: "",
    };
    expect(formSignature(fields, PASS)).toBe("4ea6184faeb24cbd40ccc77a361fc038");
    const keys = orderedFormFields(fields).map(([k]) => k);
    expect(keys[0]).toBe("merchant_id");
    expect(keys.at(-1)).toBe("subscription_type");
    expect(keys).not.toContain("name_last");
  });

  test("payment notification signature", () => {
    const pairs: [string, string][] = [
      ["m_payment_id", "NY0R02192-01"], ["pf_payment_id", "1089250"], ["payment_status", "COMPLETE"],
      ["item_name", "OnPoint Starter (monthly)"], ["amount_gross", "239.20"], ["name_first", "Dee O'Neil"],
      ["email_address", "owner+test@example.co.za"], ["merchant_id", "10000100"],
      ["token", "dc0521d3-55fe-269b-fa00-b647310d760f"], ["signature", "3a588592e35ce638a9a7e9df04c3b3b8"],
    ];
    expect(validItnSignature(pairs, PASS)).toBe(true);
    // A changed amount fails
    const tampered = pairs.map(([k, v]) => [k, k === "amount_gross" ? "1.00" : v]) as [string, string][];
    expect(validItnSignature(tampered, PASS)).toBe(false);
    expect(validItnSignature(pairs, "wrong")).toBe(false);
  });

  test("API (ad hoc charge) signature", () => {
    expect(apiSignature({
      "merchant-id": "10000100", version: "v1", timestamp: "2026-10-10T21:00:00+00:00",
      amount: 23920, item_name: "OnPoint Starter (monthly)", m_payment_id: "NY0R02192-02",
    }, PASS)).toBe("14b11c197ae36c71421e7827aab713ef");
  });
});
