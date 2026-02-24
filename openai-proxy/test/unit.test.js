/**
 * Unit Tests – Proxy cost calculation & provider detection
 *
 * Tests the pure billing math with zero database or network dependencies.
 * Validates:
 *  - Cost calculation for every supported model
 *  - Zero-token requests evaluate to $0
 *  - Unknown models fall back to default pricing
 *  - Math.ceil rounding (no fractional microdollars)
 *  - Floating-point safety
 *  - Provider detection from model names
 *  - Anthropic translation layer
 */

/* ── Mock external dependencies so we can import the module ── */

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(() => ({
    doc: jest.fn(),
    collection: jest.fn(),
    runTransaction: jest.fn(),
  })), {
    FieldValue: {serverTimestamp: jest.fn()},
  }),
  auth: jest.fn(() => ({verifyIdToken: jest.fn()})),
}));

jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn(),
  })),
}));

jest.mock("axios");

const {
  calculateCostMicros,
  detectProvider,
  toAnthropicRequest,
  fromAnthropicResponse,
  PRICING,
  DEFAULT_PRICING,
  MIN_BALANCE_MICROS,
} = require("../index");

/* ═══════════════════════════════════════════════
   1. Cost Calculation – Every Model
   ═══════════════════════════════════════════════ */

describe("calculateCostMicros", () => {
  /* ── OpenAI models ── */

  test("gpt-4o: 1K input + 500 output", () => {
    // (1000 * 2_500_000 + 500 * 10_000_000) / 1_000_000
    // = (2_500_000_000 + 5_000_000_000) / 1_000_000
    // = 7500
    expect(calculateCostMicros("gpt-4o", 1000, 500)).toBe(7500);
  });

  test("gpt-4o-mini: 1K input + 500 output", () => {
    // (1000 * 150_000 + 500 * 600_000) / 1_000_000
    // = (150_000_000 + 300_000_000) / 1_000_000
    // = 450
    expect(calculateCostMicros("gpt-4o-mini", 1000, 500)).toBe(450);
  });

  test("gpt-4-turbo: 1K input + 500 output", () => {
    expect(calculateCostMicros("gpt-4-turbo", 1000, 500)).toBe(25000);
  });

  test("gpt-3.5-turbo: 1K input + 500 output", () => {
    // (1000 * 500_000 + 500 * 1_500_000) / 1_000_000 = 1250
    expect(calculateCostMicros("gpt-3.5-turbo", 1000, 500)).toBe(1250);
  });

  test("o1: 1K input + 500 output", () => {
    expect(calculateCostMicros("o1", 1000, 500)).toBe(45000);
  });

  test("o1-mini: 1K input + 500 output", () => {
    expect(calculateCostMicros("o1-mini", 1000, 500)).toBe(9000);
  });

  test("o3-mini: 1K input + 500 output", () => {
    expect(calculateCostMicros("o3-mini", 1000, 500)).toBe(3300);
  });

  /* ── Anthropic models ── */

  test("claude-sonnet-4: 1K input + 500 output", () => {
    expect(calculateCostMicros("claude-sonnet-4-20250514", 1000, 500)).toBe(10500);
  });

  test("claude-opus-4: 1K input + 500 output", () => {
    expect(calculateCostMicros("claude-opus-4-20250514", 1000, 500)).toBe(52500);
  });

  test("claude-haiku-4: 1K input + 500 output", () => {
    expect(calculateCostMicros("claude-haiku-4-20250414", 1000, 500)).toBe(2800);
  });

  test("claude-3-5-sonnet: 1K input + 500 output", () => {
    expect(calculateCostMicros("claude-3-5-sonnet-20241022", 1000, 500)).toBe(10500);
  });

  test("claude-3-5-haiku: 1K input + 500 output", () => {
    expect(calculateCostMicros("claude-3-5-haiku-20241022", 1000, 500)).toBe(2800);
  });

  /* ── Google models ── */

  test("gemini-2.5-pro: 1K input + 500 output", () => {
    expect(calculateCostMicros("gemini-2.5-pro", 1000, 500)).toBe(6250);
  });

  test("gemini-2.5-flash: 1K input + 500 output", () => {
    expect(calculateCostMicros("gemini-2.5-flash", 1000, 500)).toBe(450);
  });

  test("gemini-2.0-flash: 1K input + 500 output", () => {
    expect(calculateCostMicros("gemini-2.0-flash", 1000, 500)).toBe(300);
  });

  /* ── Mistral models ── */

  test("mistral-large: 1K input + 500 output", () => {
    expect(calculateCostMicros("mistral-large-latest", 1000, 500)).toBe(5000);
  });

  test("mistral-small: 1K input + 500 output", () => {
    expect(calculateCostMicros("mistral-small-latest", 1000, 500)).toBe(500);
  });

  /* ── Together models ── */

  test("llama-3.1-70b: 1K input + 500 output", () => {
    expect(
      calculateCostMicros("meta-llama/Llama-3.1-70B-Instruct-Turbo", 1000, 500),
    ).toBe(1320);
  });

  test("llama-3.1-8b: 1K input + 500 output", () => {
    expect(
      calculateCostMicros("meta-llama/Llama-3.1-8B-Instruct-Turbo", 1000, 500),
    ).toBe(270);
  });

  test("deepseek-v3: 1K input + 500 output", () => {
    expect(
      calculateCostMicros("deepseek-ai/DeepSeek-V3", 1000, 500),
    ).toBe(1350);
  });
});

/* ═══════════════════════════════════════════════
   2. Edge Cases
   ═══════════════════════════════════════════════ */

describe("cost calculation edge cases", () => {
  test("zero tokens = $0", () => {
    expect(calculateCostMicros("gpt-4o", 0, 0)).toBe(0);
  });

  test("zero input, some output", () => {
    // 0 input + 100 output at gpt-4o rate: (0 + 100*10_000_000)/1_000_000 = 1000
    expect(calculateCostMicros("gpt-4o", 0, 100)).toBe(1000);
  });

  test("some input, zero output", () => {
    // 100 input + 0 output at gpt-4o rate: (100*2_500_000 + 0)/1_000_000 = 250
    expect(calculateCostMicros("gpt-4o", 100, 0)).toBe(250);
  });

  test("unknown model falls back to default (gpt-4o) pricing", () => {
    const defaultCost = calculateCostMicros("unknown-model-v99", 1000, 500);
    const gpt4oCost = calculateCostMicros("gpt-4o", 1000, 500);
    expect(defaultCost).toBe(gpt4oCost);
  });

  test("Math.ceil rounds up fractional microdollars", () => {
    // 1 input token at gpt-4o-mini: (1 * 150_000) / 1_000_000 = 0.15
    // Math.ceil(0.15) = 1
    expect(calculateCostMicros("gpt-4o-mini", 1, 0)).toBe(1);
  });

  test("result is always an integer (no floating-point microdollars)", () => {
    for (const model of Object.keys(PRICING)) {
      for (const input of [0, 1, 7, 100, 1000, 12345]) {
        for (const output of [0, 1, 7, 100, 500, 9999]) {
          const cost = calculateCostMicros(model, input, output);
          expect(Number.isInteger(cost)).toBe(true);
          expect(cost).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test("large token counts do not overflow", () => {
    // 1M input + 1M output at o1 pricing (most expensive)
    const cost = calculateCostMicros("o1", 1_000_000, 1_000_000);
    // (1M * 15M + 1M * 60M) / 1M = 15M + 60M = 75,000,000
    expect(cost).toBe(75_000_000);
    expect(Number.isSafeInteger(cost)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════
   3. Microdollar Conversion Safety
   ═══════════════════════════════════════════════ */

describe("microdollar precision", () => {
  test("MIN_BALANCE_MICROS is $0.001", () => {
    expect(MIN_BALANCE_MICROS).toBe(1000);
  });

  test("$1 in microdollars is exactly 1,000,000", () => {
    // Verify the pricing table uses this unit consistently
    // gpt-4o input: $2.50 per 1M tokens = 2_500_000 micros per 1M tokens
    expect(PRICING["gpt-4o"].input).toBe(2_500_000);
  });

  test("DEFAULT_PRICING matches gpt-4o", () => {
    expect(DEFAULT_PRICING.input).toBe(PRICING["gpt-4o"].input);
    expect(DEFAULT_PRICING.output).toBe(PRICING["gpt-4o"].output);
  });
});

/* ═══════════════════════════════════════════════
   4. Provider Detection
   ═══════════════════════════════════════════════ */

describe("detectProvider", () => {
  test("OpenAI models", () => {
    expect(detectProvider("gpt-4o")).toBe("openai");
    expect(detectProvider("gpt-4o-mini")).toBe("openai");
    expect(detectProvider("gpt-3.5-turbo")).toBe("openai");
    expect(detectProvider("gpt-4-turbo")).toBe("openai");
    expect(detectProvider("o1")).toBe("openai");
    expect(detectProvider("o1-mini")).toBe("openai");
    expect(detectProvider("o3-mini")).toBe("openai");
    expect(detectProvider("o4-mini")).toBe("openai");
  });

  test("Anthropic models", () => {
    expect(detectProvider("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(detectProvider("claude-opus-4-20250514")).toBe("anthropic");
    expect(detectProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
    expect(detectProvider("claude-3-5-haiku-20241022")).toBe("anthropic");
  });

  test("Google models", () => {
    expect(detectProvider("gemini-2.5-pro")).toBe("google");
    expect(detectProvider("gemini-2.5-flash")).toBe("google");
    expect(detectProvider("gemini-2.0-flash")).toBe("google");
  });

  test("Mistral models", () => {
    expect(detectProvider("mistral-large-latest")).toBe("mistral");
    expect(detectProvider("mistral-small-latest")).toBe("mistral");
  });

  test("Together (fallback) for open source models", () => {
    expect(detectProvider("meta-llama/Llama-3.1-70B-Instruct-Turbo")).toBe("together");
    expect(detectProvider("deepseek-ai/DeepSeek-V3")).toBe("together");
    expect(detectProvider("some-unknown-model")).toBe("together");
  });
});

/* ═══════════════════════════════════════════════
   5. Anthropic Translation Layer
   ═══════════════════════════════════════════════ */

describe("toAnthropicRequest", () => {
  test("extracts system messages", () => {
    const result = toAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      messages: [
        {role: "system", content: "You are helpful."},
        {role: "user", content: "Hello"},
      ],
    });
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toEqual([{role: "user", content: "Hello"}]);
  });

  test("merges consecutive same-role messages", () => {
    const result = toAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      messages: [
        {role: "user", content: "Part 1"},
        {role: "user", content: "Part 2"},
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Part 1\nPart 2");
  });

  test("sets max_tokens from model default when not provided", () => {
    const result = toAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{role: "user", content: "Hi"}],
    });
    expect(result.max_tokens).toBe(8192);
  });

  test("passes through temperature, top_p, stop", () => {
    const result = toAnthropicRequest({
      model: "claude-sonnet-4-20250514",
      messages: [{role: "user", content: "Hi"}],
      temperature: 0.7,
      top_p: 0.9,
      stop: ["END"],
    });
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop_sequences).toEqual(["END"]);
  });
});

describe("fromAnthropicResponse", () => {
  test("translates Anthropic response to OpenAI format", () => {
    const anthropicData = {
      id: "msg_123",
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      content: [{type: "text", text: "Hello there!"}],
      usage: {input_tokens: 10, output_tokens: 5},
    };

    const result = fromAnthropicResponse(anthropicData);

    expect(result.id).toBe("msg_123");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].message.content).toBe("Hello there!");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  test("maps stop reasons correctly", () => {
    const make = (reason) => fromAnthropicResponse({
      id: "x", model: "x", stop_reason: reason,
      content: [{type: "text", text: ""}],
      usage: {input_tokens: 0, output_tokens: 0},
    });

    expect(make("end_turn").choices[0].finish_reason).toBe("stop");
    expect(make("max_tokens").choices[0].finish_reason).toBe("length");
    expect(make("stop_sequence").choices[0].finish_reason).toBe("stop");
    expect(make("tool_use").choices[0].finish_reason).toBe("tool_calls");
  });
});
