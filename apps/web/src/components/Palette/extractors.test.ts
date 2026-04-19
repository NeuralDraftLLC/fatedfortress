import test from "node:test";
import assert from "node:assert";
import {
  extractCategory,
  extractAccess,
  extractPrice,
  extractRoomId,
  extractReceiptId,
  extractModel,
} from "./extractors.ts";

test("extractCategory", () => {
  const cases = [
    { input: ["code"], expected: "code" },
    { input: ["coding"], expected: "code" },
    { input: ["dev"], expected: "code" },
    { input: ["animation"], expected: "animation" },
    { input: ["video"], expected: "animation" },
    { input: ["audio"], expected: "audio" },
    { input: ["music"], expected: "audio" },
    { input: ["game"], expected: "games" },
    { input: ["jam"], expected: "games" },
    { input: ["writing"], expected: "writing" },
    { input: ["prose"], expected: "writing" },
    { input: ["general"], expected: "general" },
    { input: ["unknown"], expected: null },
    { input: [], expected: null },
    { input: ["some", "dev", "room"], expected: "code" },
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(extractCategory(input), expected, `Failed for input: ${input}`);
  }
});

test("extractAccess", () => {
  const cases = [
    { input: ["paid"], expected: "paid" },
    { input: ["charge"], expected: "paid" },
    { input: ["premium"], expected: "paid" },
    { input: ["free"], expected: "free" },
    { input: ["public"], expected: "free" },
    { input: ["open"], expected: "free" },
    { input: ["unpaid"], expected: "free" },
    { input: ["unknown"], expected: null },
    { input: [], expected: null },
    { input: ["free", "paid"], expected: "paid" }, // paid takes precedence in current implementation
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(extractAccess(input), expected, `Failed for input: ${input}`);
  }
});

test("extractPrice", () => {
  const cases = [
    { input: ["5"], expected: 5 },
    { input: ["10.5"], expected: 10.5 },
    { input: ["0"], expected: null }, // n > 0
    { input: ["10000"], expected: null }, // n < 10000
    { input: ["9999.99"], expected: 9999.99 },
    { input: ["abc"], expected: null },
    { input: ["-5"], expected: null },
    { input: [], expected: null },
    { input: ["foo", "42", "bar"], expected: 42 },
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(extractPrice(input), expected, `Failed for input: ${input}`);
  }
});

test("extractRoomId", () => {
  const cases = [
    { input: ["rm_abc123"], expected: "rm_abc123" },
    { input: ["rm_123456789"], expected: "rm_123456789" },
    { input: ["rm_abc"], expected: null }, // too short (needs 6+)
    { input: ["room_abc123"], expected: null },
    { input: ["abc123rm_"], expected: null },
    { input: [], expected: null },
    { input: ["random", "rm_abcdef"], expected: "rm_abcdef" },
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(extractRoomId(input), expected, `Failed for input: ${input}`);
  }
});

test("extractReceiptId", () => {
  const cases = [
    { input: ["rcp_abcdef01"], expected: "rcp_abcdef01" },
    { input: ["rcp_1234567890abcdef"], expected: "rcp_1234567890abcdef" },
    { input: ["rcp_abc"], expected: null }, // too short (needs 8+)
    { input: ["rcp_ghijklmnopqrst"], expected: null }, // not hex
    { input: [], expected: null },
    { input: ["receipt", "rcp_00000000"], expected: "rcp_00000000" },
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(extractReceiptId(input), expected, `Failed for input: ${input}`);
  }
});

test("extractModel", () => {
  const cases = [
    {
      input: ["gpt", "4o"],
      expected: { model: { provider: "openai", model: "gpt-4o" }, rawModelName: "gpt-4o" },
    },
    {
      input: ["claude", "sonnet"],
      expected: { model: { provider: "anthropic", model: "claude-4-sonnet" }, rawModelName: "claude-sonnet" },
    },
    {
      input: ["o3"],
      expected: { model: { provider: "openai", model: "o3" }, rawModelName: "o3" },
    },
    {
      input: ["gemini"],
      expected: { model: { provider: "google", model: "gemini-2.0-flash" }, rawModelName: "gemini" },
    },
    {
      input: ["openai"],
      expected: { model: null, rawModelName: "openai" },
    },
    {
      input: ["unknown"],
      expected: { model: null, rawModelName: "" },
    },
    {
      input: [],
      expected: { model: null, rawModelName: "" },
    },
  ];

  for (const { input, expected } of cases) {
    const actual = extractModel(input);
    assert.deepStrictEqual(actual, expected, `Failed for input: ${input}`);
  }
});
