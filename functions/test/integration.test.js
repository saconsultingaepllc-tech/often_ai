/**
 * Integration Tests – Cloud Function handlers
 *
 * Tests deposit, transfer, and convert endpoints with
 * mocked Firebase Admin SDK (no emulator required).
 *
 * Validates:
 *  - Double-entry ledger correctness
 *  - Insufficient funds rejection
 *  - Admin endpoint hardening
 *  - Input validation at the API boundary
 */

/* ── Shared mutable state simulating Firestore ── */

const accounts = {};
const transactions = [];

function resetDb() {
  for (const key of Object.keys(accounts)) delete accounts[key];
  transactions.length = 0;
}

function seedAccount(uid, balances) {
  accounts[uid] = {balances: {...balances}, status: "active", email: `${uid}@test.com`};
}

/* ── Mock firebase-admin ── */

process.env.FIREBASE_WEB_API_KEY = "test-api-key";
process.env.ADMIN_API_KEY = "test-admin-key-12345";

const mockVerifyIdToken = jest.fn();

jest.mock("firebase-admin", () => {
  const mockDb = {
    doc: jest.fn((path) => {
      const uid = path.split("/").pop();
      return {
        get: jest.fn(async () => ({
          exists: !!accounts[uid],
          data: () => accounts[uid] ? {...accounts[uid]} : undefined,
        })),
        set: jest.fn(async (data) => {
          accounts[uid] = data;
        }),
        update: jest.fn(async (data) => {
          if (!accounts[uid]) throw new Error("NOT_FOUND");
          for (const [key, val] of Object.entries(data)) {
            if (key.startsWith("balances.")) {
              const currency = key.split(".")[1];
              accounts[uid].balances[currency] = val;
            } else {
              accounts[uid][key] = val;
            }
          }
        }),
      };
    }),
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({id: `tx-${Date.now()}-${Math.random()}`})),
    })),
    runTransaction: jest.fn(async (fn) => {
      // Simulate atomic transaction with doc access
      const tx = {
        get: jest.fn(async (ref) => {
          // ref is the return value of db.doc() — we need the uid
          // Extract from last call to db.doc
          const lastDocCall = mockDb.doc.mock.calls;
          const lastPath = lastDocCall[lastDocCall.length - 1]?.[0] ||
            lastDocCall[lastDocCall.length - 2]?.[0];
          const uid = lastPath?.split("/").pop();
          return {
            exists: !!accounts[uid],
            data: () => accounts[uid] ? {...accounts[uid]} : undefined,
          };
        }),
        update: jest.fn((ref, data) => {
          // Find which account to update based on recent doc calls
          const lastCalls = mockDb.doc.mock.calls;
          // Search backwards for relevant paths
          for (let i = lastCalls.length - 1; i >= 0; i--) {
            const path = lastCalls[i][0];
            if (path.startsWith("accounts/")) {
              const uid = path.split("/").pop();
              if (accounts[uid]) {
                for (const [key, val] of Object.entries(data)) {
                  if (key.startsWith("balances.")) {
                    const currency = key.split(".")[1];
                    accounts[uid].balances[currency] = val;
                  }
                }
                break;
              }
            }
          }
        }),
        create: jest.fn((ref, data) => {
          transactions.push(data);
        }),
      };
      await fn(tx);
    }),
  };

  return {
    initializeApp: jest.fn(),
    firestore: Object.assign(jest.fn(() => mockDb), {
      FieldValue: {serverTimestamp: jest.fn(() => "MOCK_TIMESTAMP")},
    }),
    auth: jest.fn(() => ({
      createUser: jest.fn(async ({email}) => ({uid: `uid-${email}`})),
      verifyIdToken: mockVerifyIdToken,
    })),
  };
});

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

/* ── Load the module (handlers are now raw (req, res) functions) ── */

const functions = require("../index");

/* ── Test helpers ── */

function mockReq(method, body = {}, headers = {}) {
  return {method, body, headers, query: {}, user: null};
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn(function(code) {
      this.statusCode = code; return this;
    }),
    json: jest.fn(function(data) {
      this.body = data; return this;
    }),
  };
  return res;
}

/* ═══════════════════════════════════════════════
   Setup
   ═══════════════════════════════════════════════ */

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({uid: "agent-a", email: "a@test.com"});
});

/* ═══════════════════════════════════════════════
   1. Deposit (Admin Endpoint)
   ═══════════════════════════════════════════════ */

describe("POST /deposit", () => {
  beforeEach(() => {
    seedAccount("agent-a", {USD: 0, USDC: 0, ETH: 0, BTC: 0, SOL: 0});
  });

  test("valid deposit increases balance", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 10_000_000, currency: "USD"},
        {"x-admin-key": "test-admin-key-12345"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(res.body.balance).toBe(10_000_000);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].type).toBe("deposit");
    expect(transactions[0].amount).toBe(10_000_000);
  });

  test("rejects without admin key (401/403)", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 10_000_000, currency: "USD"},
        {},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
    expect(transactions).toHaveLength(0);
  });

  test("rejects with wrong admin key", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 10_000_000, currency: "USD"},
        {"x-admin-key": "wrong-key"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(403);
  });

  test("rejects SQL injection in admin key", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 10_000_000, currency: "USD"},
        {"x-admin-key": "' OR 1=1 --"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(403);
  });

  test("rejects with user bearer token instead of admin key", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 10_000_000, currency: "USD"},
        {"authorization": "Bearer some-token"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(403);
  });

  test("rejects zero amount", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 0, currency: "USD"},
        {"x-admin-key": "test-admin-key-12345"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects negative amount", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: -100, currency: "USD"},
        {"x-admin-key": "test-admin-key-12345"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects unsupported currency", async () => {
    const req = mockReq("POST",
        {accountId: "agent-a", amount: 1000, currency: "DOGE"},
        {"x-admin-key": "test-admin-key-12345"},
    );
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects non-POST method", async () => {
    const req = mockReq("GET", {}, {"x-admin-key": "test-admin-key-12345"});
    const res = mockRes();

    await functions.deposit(req, res);

    expect(res.statusCode).toBe(405);
  });
});

/* ═══════════════════════════════════════════════
   2. Transfer (Double-Entry Ledger)
   ═══════════════════════════════════════════════ */

describe("POST /transfer", () => {
  test("valid transfer: A sends 1M to B, balances correct", async () => {
    seedAccount("agent-a", {USD: 5_000_000, USDC: 0, ETH: 0, BTC: 0, SOL: 0});
    seedAccount("agent-b", {USD: 0, USDC: 0, ETH: 0, BTC: 0, SOL: 0});

    // For transfer, the mock transaction needs to handle two accounts
    // We need a more sophisticated mock that tracks which doc is being read
    const admin = require("firebase-admin");
    const db = admin.firestore();
    db.runTransaction.mockImplementationOnce(async (fn) => {
      const senderSnap = {
        exists: true,
        data: () => ({...accounts["agent-a"]}),
      };
      const recipientSnap = {
        exists: true,
        data: () => ({...accounts["agent-b"]}),
      };
      let callCount = 0;
      const tx = {
        get: jest.fn(async () => {
          callCount++;
          return callCount <= 1 ? senderSnap : recipientSnap;
        }),
        update: jest.fn(),
        create: jest.fn((_, data) => transactions.push(data)),
      };
      await fn(tx);

      // Apply the updates manually based on tx.update calls
      for (const call of tx.update.mock.calls) {
        const data = call[1];
        for (const [key, val] of Object.entries(data)) {
          if (key === "balances.USD") {
            // Determine which account based on order
            const idx = tx.update.mock.calls.indexOf(call);
            const uid = idx === 0 ? "agent-a" : "agent-b";
            accounts[uid].balances.USD = val;
          }
        }
      }
    });

    const req = mockReq("POST",
        {toAccountId: "agent-b", amount: 1_000_000, currency: "USD"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.balance).toBe(4_000_000);
    expect(accounts["agent-a"].balances.USD).toBe(4_000_000);
    expect(accounts["agent-b"].balances.USD).toBe(1_000_000);

    // Double-entry: exactly 2 transaction records
    const txRecords = transactions.filter(
        (t) => t.type === "transfer_out" || t.type === "transfer_in",
    );
    expect(txRecords).toHaveLength(2);
    expect(txRecords.find((t) => t.type === "transfer_out").amount).toBe(1_000_000);
    expect(txRecords.find((t) => t.type === "transfer_in").amount).toBe(1_000_000);
  });

  test("insufficient funds: balance unchanged", async () => {
    seedAccount("agent-a", {USD: 1_000_000, USDC: 0, ETH: 0, BTC: 0, SOL: 0});
    seedAccount("agent-b", {USD: 0, USDC: 0, ETH: 0, BTC: 0, SOL: 0});

    const admin = require("firebase-admin");
    const db = admin.firestore();
    db.runTransaction.mockImplementationOnce(async (fn) => {
      const tx = {
        get: jest.fn(async () => ({
          exists: true,
          data: () => ({...accounts["agent-a"]}),
        })),
        update: jest.fn(),
        create: jest.fn(),
      };
      await fn(tx);
    });

    const req = mockReq("POST",
        {toAccountId: "agent-b", amount: 5_000_000, currency: "USD"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(402);
    expect(res.body.error).toMatch(/insufficient/i);
    // Balance unchanged
    expect(accounts["agent-a"].balances.USD).toBe(1_000_000);
  });

  test("cannot transfer to yourself", async () => {
    seedAccount("agent-a", {USD: 5_000_000, USDC: 0, ETH: 0, BTC: 0, SOL: 0});

    const req = mockReq("POST",
        {toAccountId: "agent-a", amount: 1_000_000, currency: "USD"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  test("rejects zero amount", async () => {
    seedAccount("agent-a", {USD: 5_000_000, USDC: 0, ETH: 0, BTC: 0, SOL: 0});

    const req = mockReq("POST",
        {toAccountId: "agent-b", amount: 0, currency: "USD"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects negative amount", async () => {
    seedAccount("agent-a", {USD: 5_000_000, USDC: 0, ETH: 0, BTC: 0, SOL: 0});

    const req = mockReq("POST",
        {toAccountId: "agent-b", amount: -500, currency: "USD"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects unsupported currency", async () => {
    const req = mockReq("POST",
        {toAccountId: "agent-b", amount: 1000, currency: "DOGE"},
        {authorization: "Bearer valid-token"},
    );
    req.user = {uid: "agent-a"};
    const res = mockRes();

    await functions.transfer(req, res);

    expect(res.statusCode).toBe(400);
  });
});

/* ═══════════════════════════════════════════════
   3. Input Validation – Signup
   ═══════════════════════════════════════════════ */

describe("POST /signup validation", () => {
  test("rejects missing email", async () => {
    const req = mockReq("POST", {password: "longpassword123"});
    const res = mockRes();

    await functions.signup(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects missing password", async () => {
    const req = mockReq("POST", {email: "test@example.com"});
    const res = mockRes();

    await functions.signup(req, res);

    expect(res.statusCode).toBe(400);
  });

  test("rejects malformed email", async () => {
    const req = mockReq("POST", {email: "not-an-email", password: "longpassword123"});
    const res = mockRes();

    await functions.signup(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test("rejects short password (< 8 chars)", async () => {
    const req = mockReq("POST", {email: "a@b.com", password: "short"});
    const res = mockRes();

    await functions.signup(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  test("rejects non-POST method", async () => {
    const req = mockReq("GET");
    const res = mockRes();

    await functions.signup(req, res);

    expect(res.statusCode).toBe(405);
  });
});

/* ═══════════════════════════════════════════════
   4. Method Enforcement
   ═══════════════════════════════════════════════ */

describe("method enforcement", () => {
  test("login rejects GET", async () => {
    const req = mockReq("GET");
    const res = mockRes();
    await functions.login(req, res);
    expect(res.statusCode).toBe(405);
  });

  test("refresh rejects GET", async () => {
    const req = mockReq("GET");
    const res = mockRes();
    await functions.refresh(req, res);
    expect(res.statusCode).toBe(405);
  });

  test("transfer rejects GET", async () => {
    const req = mockReq("GET");
    const res = mockRes();
    await functions.transfer(req, res);
    expect(res.statusCode).toBe(405);
  });

  test("convert rejects GET", async () => {
    const req = mockReq("GET");
    const res = mockRes();
    await functions.convert(req, res);
    expect(res.statusCode).toBe(405);
  });
});
