/**
 * Firestore Security Rules – Exploit Testing
 *
 * Verifies that agents cannot bypass the API to directly
 * read or write their bank balances or transaction records.
 *
 * Requires: Firebase Firestore emulator running on port 8080
 *   firebase emulators:start --only firestore
 */

const {
  initializeTestEnvironment,
  assertFails,
} = require("@firebase/rules-unit-testing");
const {readFileSync} = require("fs");
const {join} = require("path");

const PROJECT_ID = "often-test";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

let testEnv;
let emulatorAvailable = false;

beforeAll(async () => {
  try {
    await fetch(`http://${FIRESTORE_HOST}`, {signal: AbortSignal.timeout(2000)});
  } catch {
    console.warn(
        "\n⚠  Firestore emulator not running. Skipping security rules tests.\n" +
      "   Start with: firebase emulators:start --only firestore\n",
    );
    return;
  }

  const rules = readFileSync(
      join(__dirname, "../../firestore.rules"),
      "utf8",
  );
  const [host, portStr] = FIRESTORE_HOST.split(":");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {host, port: parseInt(portStr, 10), rules},
  });
  emulatorAvailable = true;
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

afterEach(async () => {
  if (testEnv) await testEnv.clearFirestore();
});

/* ═══════════════════════════════════════════════
   1. Direct Write Denial – Accounts
   ═══════════════════════════════════════════════ */

describe("accounts collection – client access blocked", () => {
  test("authenticated agent CANNOT write to own account", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.set({balances: {USD: 999_999_999}}));
  });

  test("authenticated agent CANNOT update own balance", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.update({"balances.USD": 999_999_999}));
  });

  test("authenticated agent CANNOT read own account", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.get());
  });

  test("authenticated agent CANNOT read another agent's account", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("accounts").doc("agent-b");
    await assertFails(doc.get());
  });

  test("authenticated agent CANNOT delete own account", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.delete());
  });

  test("unauthenticated user CANNOT read any account", async () => {
    if (!emulatorAvailable) return;
    const unauth = testEnv.unauthenticatedContext();
    const doc = unauth.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.get());
  });

  test("unauthenticated user CANNOT write any account", async () => {
    if (!emulatorAvailable) return;
    const unauth = testEnv.unauthenticatedContext();
    const doc = unauth.firestore().collection("accounts").doc("agent-a");
    await assertFails(doc.set({balances: {USD: 1}}));
  });
});

/* ═══════════════════════════════════════════════
   2. Direct Write Denial – Transactions (Ledger)
   ═══════════════════════════════════════════════ */

describe("transactions collection – client access blocked", () => {
  test("authenticated agent CANNOT create a fake deposit", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const col = agentA.firestore().collection("transactions");
    await assertFails(
        col.add({
          accountId: "agent-a",
          type: "deposit",
          currency: "USD",
          amount: 10_000_000,
          description: "Fake deposit",
        }),
    );
  });

  test("authenticated agent CANNOT create a fake transfer_in", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const col = agentA.firestore().collection("transactions");
    await assertFails(
        col.add({
          accountId: "agent-a",
          type: "transfer_in",
          amount: 5_000_000,
          description: "Fabricated incoming transfer",
        }),
    );
  });

  test("authenticated agent CANNOT read own transactions", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const col = agentA.firestore().collection("transactions");
    await assertFails(
        col.where("accountId", "==", "agent-a").get(),
    );
  });

  test("authenticated agent CANNOT read other agents' transactions", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const col = agentA.firestore().collection("transactions");
    await assertFails(
        col.where("accountId", "==", "agent-b").get(),
    );
  });

  test("authenticated agent CANNOT delete transaction records", async () => {
    if (!emulatorAvailable) return;
    const agentA = testEnv.authenticatedContext("agent-a");
    const doc = agentA.firestore().collection("transactions").doc("some-tx");
    await assertFails(doc.delete());
  });

  test("unauthenticated user CANNOT write transactions", async () => {
    if (!emulatorAvailable) return;
    const unauth = testEnv.unauthenticatedContext();
    const col = unauth.firestore().collection("transactions");
    await assertFails(
        col.add({accountId: "x", type: "deposit", amount: 1}),
    );
  });
});

/* ═══════════════════════════════════════════════
   3. Admin SDK bypass verification
   ═══════════════════════════════════════════════ */

describe("admin SDK bypass", () => {
  test("admin context CAN write to accounts (server-side)", async () => {
    if (!emulatorAvailable) return;
    let data;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const doc = context.firestore().collection("accounts").doc("agent-a");
      await doc.set({balances: {USD: 1_000_000}, status: "active"});
      const snap = await doc.get();
      data = snap.data();
    });
    expect(data.balances.USD).toBe(1_000_000);
  });

  test("admin context CAN write transactions (server-side)", async () => {
    if (!emulatorAvailable) return;
    let data;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const col = context.firestore().collection("transactions");
      const ref = await col.add({
        accountId: "agent-a",
        type: "deposit",
        amount: 5_000_000,
      });
      const snap = await ref.get();
      data = snap.data();
    });
    expect(data.type).toBe("deposit");
  });
});
