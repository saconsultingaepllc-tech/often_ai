/**
 * Unit Tests – Pure business logic (no database, no network)
 *
 * Covers:
 *  - Email validation
 *  - Currency conversion (BigInt precision)
 *  - Admin key checking
 *  - Input validation constants
 */

/* ── Mock firebase-admin & firebase-functions before loading module ── */

process.env.FIREBASE_WEB_API_KEY = "test-key";
process.env.ADMIN_API_KEY = "secret-admin-key";

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(() => ({})), {
    FieldValue: {serverTimestamp: jest.fn(() => "TS")},
  }),
  auth: jest.fn(() => ({
    createUser: jest.fn(),
    verifyIdToken: jest.fn(),
  })),
}));
jest.mock("firebase-functions", () => ({
  setGlobalOptions: jest.fn(),
}));
jest.mock("firebase-functions/v2/https", () => ({
  onRequest: jest.fn((_opts, handler) => handler),
}));
jest.mock("firebase-functions/logger", () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const {_test} = require("../index");
const {isValidEmail, convertCurrency, isAdmin, checkRateLimit, UNITS, SUPPORTED, EMPTY_BALANCES} = _test;

/* ═══════════════════════════════════════════════
   1. Email Validation
   ═══════════════════════════════════════════════ */

describe("isValidEmail", () => {
  test("accepts standard email", () => {
    expect(isValidEmail("agent@often.ai")).toBe(true);
  });

  test("accepts email with subdomains", () => {
    expect(isValidEmail("a@sub.domain.com")).toBe(true);
  });

  test("accepts email with + alias", () => {
    expect(isValidEmail("user+tag@gmail.com")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  test("rejects missing @", () => {
    expect(isValidEmail("nodomain.com")).toBe(false);
  });

  test("rejects missing TLD", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  test("rejects spaces", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
  });

  test("rejects double @", () => {
    expect(isValidEmail("a@@b.com")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════
   2. Currency Conversion (BigInt precision)
   ═══════════════════════════════════════════════ */

describe("convertCurrency", () => {
  const rates = {
    USD: 1,
    USDC: 1,
    ETH: 3500,
    BTC: 65000,
    SOL: 150,
  };

  test("same currency returns exact amount", () => {
    expect(convertCurrency("USD", "USD", 1_000_000, rates)).toBe(1_000_000);
  });

  test("USD to USDC is 1:1 (both pegged)", () => {
    const result = convertCurrency("USD", "USDC", 5_000_000, rates);
    expect(result).toBe(5_000_000);
  });

  test("USD to ETH conversion", () => {
    // $1 = 1,000,000 micros USD
    // ETH = $3500 → 1 ETH = 1,000,000,000 gwei-units
    // $1 worth of ETH = 1/3500 ETH = 1_000_000_000 / 3500 = ~285714 units
    const usdAmount = 1_000_000; // $1 in micros
    const result = convertCurrency("USD", "ETH", usdAmount, rates);
    // BigInt: (1_000_000 * 100 * 1_000_000_000) / (1_000_000 * 350000)
    // = (100_000_000_000_000_000) / (350_000_000_000)
    // = 285714 (integer division)
    expect(result).toBe(285714);
  });

  test("ETH to USD conversion", () => {
    // 1 ETH unit (1 gwei-unit) = $3500 / 1_000_000_000
    // 1_000_000_000 units = 1 ETH = $3500 = 3,500,000,000 micros USD
    const ethAmount = 1_000_000_000; // 1 ETH in smallest units
    const result = convertCurrency("ETH", "USD", ethAmount, rates);
    expect(result).toBe(3_500_000_000);
  });

  test("BTC to USD conversion", () => {
    const btcAmount = 100_000_000; // 1 BTC in satoshis
    const result = convertCurrency("BTC", "USD", btcAmount, rates);
    expect(result).toBe(65_000_000_000); // $65,000 in micros
  });

  test("small amount does not overflow", () => {
    // 1 micro USD → ETH
    const result = convertCurrency("USD", "ETH", 1, rates);
    // Very small: should be 0 due to integer truncation
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  test("large amount does not overflow (BigInt safety)", () => {
    // 1 billion dollars worth of BTC → USD
    const btcAmount = 100_000_000 * 1000; // 1000 BTC
    const result = convertCurrency("BTC", "USD", btcAmount, rates);
    expect(result).toBe(65_000_000_000_000); // $65M in micros
    expect(Number.isSafeInteger(result)).toBe(true);
  });

  test("cross-crypto conversion (ETH → BTC)", () => {
    // 1 ETH = $3500, 1 BTC = $65000
    // 1 ETH = 3500/65000 BTC ≈ 0.05384615 BTC ≈ 5384615 satoshis
    const ethAmount = 1_000_000_000; // 1 ETH
    const result = convertCurrency("ETH", "BTC", ethAmount, rates);
    expect(result).toBe(5384615);
  });
});

/* ═══════════════════════════════════════════════
   3. Admin Key Checking
   ═══════════════════════════════════════════════ */

describe("isAdmin", () => {
  test("returns true for correct admin key", () => {
    const req = {headers: {"x-admin-key": "secret-admin-key"}};
    expect(isAdmin(req)).toBe(true);
  });

  test("returns false for missing admin key header", () => {
    const req = {headers: {}};
    expect(isAdmin(req)).toBe(false);
  });

  test("returns false for wrong admin key", () => {
    const req = {headers: {"x-admin-key": "wrong-key"}};
    expect(isAdmin(req)).toBe(false);
  });

  test("returns false for empty admin key", () => {
    const req = {headers: {"x-admin-key": ""}};
    expect(isAdmin(req)).toBe(false);
  });

  test("rejects SQL injection attempt", () => {
    const req = {headers: {"x-admin-key": "' OR 1=1 --"}};
    expect(isAdmin(req)).toBe(false);
  });

  test("rejects NoSQL injection attempt", () => {
    const req = {headers: {"x-admin-key": '{"$gt": ""}'}};
    expect(isAdmin(req)).toBe(false);
  });

  test("returns false when ADMIN_API_KEY env is unset", () => {
    const original = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    const req = {headers: {"x-admin-key": "anything"}};
    expect(isAdmin(req)).toBeFalsy();
    process.env.ADMIN_API_KEY = original;
  });
});

/* ═══════════════════════════════════════════════
   4. Rate Limiting
   ═══════════════════════════════════════════════ */

describe("checkRateLimit", () => {
  function makeReq(ip = "1.2.3.4") {
    return {ip, headers: {}};
  }

  function makeRes() {
    const res = {
      statusCode: 200,
      body: null,
      status: jest.fn(function(code) { this.statusCode = code; return this; }),
      json: jest.fn(function(data) { this.body = data; return this; }),
    };
    return res;
  }

  test("allows first request", () => {
    const req = makeReq("10.0.0.1");
    const res = makeRes();
    expect(checkRateLimit("signup", req, res)).toBe(true);
  });

  test("blocks after exceeding signup limit (5 per minute)", () => {
    const ip = `rate-test-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      expect(checkRateLimit("signup", makeReq(ip), res)).toBe(true);
    }
    // 6th request should be blocked
    const res = makeRes();
    expect(checkRateLimit("signup", makeReq(ip), res)).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  test("different IPs have independent limits", () => {
    const ts = Date.now();
    for (let i = 0; i < 5; i++) {
      checkRateLimit("signup", makeReq(`ip-a-${ts}`), makeRes());
    }
    // ip-a is exhausted, ip-b should still be allowed
    const res = makeRes();
    expect(checkRateLimit("signup", makeReq(`ip-b-${ts}`), res)).toBe(true);
  });

  test("uses x-forwarded-for header when ip is unavailable", () => {
    const req = {headers: {"x-forwarded-for": `xff-${Date.now()}`}};
    const res = makeRes();
    expect(checkRateLimit("login", req, res)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════
   5. Constants & Schema
   ═══════════════════════════════════════════════ */

describe("constants", () => {
  test("SUPPORTED currencies include expected set", () => {
    expect(SUPPORTED).toEqual(["USD", "USDC", "ETH", "BTC", "SOL"]);
  });

  test("UNITS has correct denominations", () => {
    expect(UNITS.USD).toBe(1_000_000);
    expect(UNITS.BTC).toBe(100_000_000);
    expect(UNITS.ETH).toBe(1_000_000_000);
  });

  test("EMPTY_BALANCES initializes all to zero", () => {
    for (const currency of SUPPORTED) {
      expect(EMPTY_BALANCES[currency]).toBe(0);
    }
    expect(Object.keys(EMPTY_BALANCES)).toHaveLength(SUPPORTED.length);
  });
});
