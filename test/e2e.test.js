/**
 * End-to-End Test – The Core Loop
 *
 * Simulates the complete lifecycle of an autonomous agent:
 *   1. Signup (create account)
 *   2. Deposit (admin funds the account)
 *   3. Verify account balance
 *   4. Transfer between agents
 *   5. Verify ledger integrity
 *
 * PREREQUISITES:
 *   firebase emulators:start --only auth,firestore,functions
 *
 * Run with:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
 *   npx jest test/e2e.test.js --forceExit
 */

const FUNCTIONS_BASE = process.env.FUNCTIONS_BASE || "http://127.0.0.1:5001/ext-hub/us-central1";
const ADMIN_API_KEY = process.env.TEST_ADMIN_KEY || "test-admin-key";

async function api(endpoint, {method = "GET", body, headers = {}} = {}) {
  const opts = {
    method,
    headers: {"Content-Type": "application/json", ...headers},
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FUNCTIONS_BASE}/${endpoint}`, opts);
  const data = await res.json().catch(() => null);
  return {status: res.status, data};
}

/* ═══════════════════════════════════════════════
   Skip if emulators are not running
   ═══════════════════════════════════════════════ */

let emulatorsAvailable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/getAccount`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    emulatorsAvailable = true;
  } catch {
    console.warn(
      "\n⚠  Firebase emulators not running. Skipping E2E tests.\n" +
      "   Start with: firebase emulators:start --only auth,firestore,functions\n",
    );
  }
});

function skipIfNoEmulators() {
  if (!emulatorsAvailable) {
    return test.skip("emulators not running", () => {});
  }
}

/* ═══════════════════════════════════════════════
   1. The Core Loop – Full Agent Lifecycle
   ═══════════════════════════════════════════════ */

describe("E2E: Agent Lifecycle", () => {
  let idToken;
  let uid;
  const email = `e2e-agent-${Date.now()}@test.often.ai`;
  const password = "TestPassword123!";

  test("Step 1: Signup – create new agent account", async () => {
    if (!emulatorsAvailable) return;

    const {status, data} = await api("signup", {
      method: "POST",
      body: {email, password},
    });

    expect(status).toBe(201);
    expect(data.idToken).toBeDefined();
    expect(data.refreshToken).toBeDefined();
    expect(data.uid).toBeDefined();

    idToken = data.idToken;
    uid = data.uid;
  });

  test("Step 2: Verify fresh account has zero balances", async () => {
    if (!emulatorsAvailable || !idToken) return;

    const {status, data} = await api("getAccount", {
      headers: {Authorization: `Bearer ${idToken}`},
    });

    expect(status).toBe(200);
    expect(data.uid).toBe(uid);
    expect(data.balances.USD).toBe(0);
    expect(data.status).toBe("active");
  });

  test("Step 3: Admin deposit – fund with $10 (10,000,000 micros)", async () => {
    if (!emulatorsAvailable || !uid) return;

    const {status, data} = await api("deposit", {
      method: "POST",
      body: {accountId: uid, amount: 10_000_000, currency: "USD"},
      headers: {"X-Admin-Key": ADMIN_API_KEY},
    });

    expect(status).toBe(200);
    expect(data.balance).toBe(10_000_000);
    expect(data.currency).toBe("USD");
  });

  test("Step 4: Verify account balance matches deposit", async () => {
    if (!emulatorsAvailable || !idToken) return;

    const {status, data} = await api("getAccount", {
      headers: {Authorization: `Bearer ${idToken}`},
    });

    expect(status).toBe(200);
    expect(data.balances.USD).toBe(10_000_000);
  });

  test("Step 5: Verify deposit appears in transaction history", async () => {
    if (!emulatorsAvailable || !idToken) return;

    const {status, data} = await api("getTransactions", {
      headers: {Authorization: `Bearer ${idToken}`},
    });

    expect(status).toBe(200);
    expect(data.transactions.length).toBeGreaterThanOrEqual(1);
    const deposit = data.transactions.find((t) => t.type === "deposit");
    expect(deposit).toBeDefined();
    expect(deposit.amount).toBe(10_000_000);
    expect(deposit.currency).toBe("USD");
  });
});

/* ═══════════════════════════════════════════════
   2. Transfer Between Agents
   ═══════════════════════════════════════════════ */

describe("E2E: Agent-to-Agent Transfer", () => {
  let tokenA, uidA;
  let tokenB, uidB;

  beforeAll(async () => {
    if (!emulatorsAvailable) return;

    // Create Agent A
    const a = await api("signup", {
      method: "POST",
      body: {
        email: `agent-a-${Date.now()}@test.often.ai`,
        password: "Password123!",
      },
    });
    tokenA = a.data.idToken;
    uidA = a.data.uid;

    // Create Agent B
    const b = await api("signup", {
      method: "POST",
      body: {
        email: `agent-b-${Date.now()}@test.often.ai`,
        password: "Password123!",
      },
    });
    tokenB = b.data.idToken;
    uidB = b.data.uid;

    // Fund Agent A with $5
    await api("deposit", {
      method: "POST",
      body: {accountId: uidA, amount: 5_000_000, currency: "USD"},
      headers: {"X-Admin-Key": ADMIN_API_KEY},
    });
  });

  test("Agent A transfers 1,000,000 micros to Agent B", async () => {
    if (!emulatorsAvailable || !tokenA) return;

    const {status, data} = await api("transfer", {
      method: "POST",
      body: {
        toAccountId: uidB,
        amount: 1_000_000,
        currency: "USD",
        description: "E2E test transfer",
      },
      headers: {Authorization: `Bearer ${tokenA}`},
    });

    expect(status).toBe(200);
    expect(data.balance).toBe(4_000_000); // 5M - 1M
  });

  test("Agent A balance is exactly 4,000,000", async () => {
    if (!emulatorsAvailable || !tokenA) return;

    const {status, data} = await api("getAccount", {
      headers: {Authorization: `Bearer ${tokenA}`},
    });

    expect(status).toBe(200);
    expect(data.balances.USD).toBe(4_000_000);
  });

  test("Agent B balance is exactly 1,000,000", async () => {
    if (!emulatorsAvailable || !tokenB) return;

    const {status, data} = await api("getAccount", {
      headers: {Authorization: `Bearer ${tokenB}`},
    });

    expect(status).toBe(200);
    expect(data.balances.USD).toBe(1_000_000);
  });

  test("Both agents have matching transaction records", async () => {
    if (!emulatorsAvailable || !tokenA || !tokenB) return;

    const [aRes, bRes] = await Promise.all([
      api("getTransactions", {headers: {Authorization: `Bearer ${tokenA}`}}),
      api("getTransactions", {headers: {Authorization: `Bearer ${tokenB}`}}),
    ]);

    const aTransferOut = aRes.data.transactions.find((t) => t.type === "transfer_out");
    const bTransferIn = bRes.data.transactions.find((t) => t.type === "transfer_in");

    expect(aTransferOut).toBeDefined();
    expect(bTransferIn).toBeDefined();
    expect(aTransferOut.amount).toBe(1_000_000);
    expect(bTransferIn.amount).toBe(1_000_000);
  });
});

/* ═══════════════════════════════════════════════
   3. Security – Admin Endpoint Hardening
   ═══════════════════════════════════════════════ */

describe("E2E: Admin Security", () => {
  test("deposit without admin key returns 403", async () => {
    if (!emulatorsAvailable) return;

    const {status} = await api("deposit", {
      method: "POST",
      body: {accountId: "any", amount: 1_000_000, currency: "USD"},
    });

    expect(status).toBe(403);
  });

  test("deposit with wrong admin key returns 403", async () => {
    if (!emulatorsAvailable) return;

    const {status} = await api("deposit", {
      method: "POST",
      body: {accountId: "any", amount: 1_000_000, currency: "USD"},
      headers: {"X-Admin-Key": "wrong-key"},
    });

    expect(status).toBe(403);
  });

  test("deposit with SQL injection key returns 403", async () => {
    if (!emulatorsAvailable) return;

    const {status} = await api("deposit", {
      method: "POST",
      body: {accountId: "any", amount: 1_000_000, currency: "USD"},
      headers: {"X-Admin-Key": "' OR 1=1 --"},
    });

    expect(status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════
   4. Auth Lifecycle
   ═══════════════════════════════════════════════ */

describe("E2E: Auth Token Lifecycle", () => {
  let refreshToken;

  test("login returns tokens", async () => {
    if (!emulatorsAvailable) return;

    const email = `auth-test-${Date.now()}@test.often.ai`;
    const password = "Password123!";

    // Signup first
    await api("signup", {method: "POST", body: {email, password}});

    // Login
    const {status, data} = await api("login", {
      method: "POST",
      body: {email, password},
    });

    expect(status).toBe(200);
    expect(data.idToken).toBeDefined();
    expect(data.refreshToken).toBeDefined();
    refreshToken = data.refreshToken;
  });

  test("refresh token returns new id token", async () => {
    if (!emulatorsAvailable || !refreshToken) return;

    const {status, data} = await api("refresh", {
      method: "POST",
      body: {refreshToken},
    });

    expect(status).toBe(200);
    expect(data.idToken).toBeDefined();
    expect(data.refreshToken).toBeDefined();
  });
});
