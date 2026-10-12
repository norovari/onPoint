import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PIN_RE, hashPin, pinMatches } from "@/lib/pin";

describe("staff PINs", () => {
  test("only 4–6 digits", () => {
    expect(PIN_RE.test("1234")).toBe(true);
    expect(PIN_RE.test("123456")).toBe(true);
    expect(PIN_RE.test("123")).toBe(false);
    expect(PIN_RE.test("12a4")).toBe(false);
  });
  test("stored scrambled, checked correctly", () => {
    const h = hashPin("4821");
    expect(h).not.toContain("4821");
    expect(pinMatches("4821", h)).toBe(true);
    expect(pinMatches("4822", h)).toBe(false);
    expect(hashPin("4821")).not.toBe(h); // salted
  });
});
