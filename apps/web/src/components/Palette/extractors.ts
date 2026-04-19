import type {
  RoomCategory,
  RoomAccess,
  ProviderId,
  ModelRef,
  RoomId,
  ReceiptId,
} from "@fatedfortress/protocol";

const CATEGORY_MAP: Record<string, RoomCategory> = {
  code:      "code",      coding:    "code",      dev:       "code",   developer: "code",
  animation: "animation", animate:   "animation", video:     "animation", motion: "animation",
  audio:     "audio",     music:     "audio",     sound:     "audio",  podcast:   "audio",
  game:      "games",     games:     "games",     gaming:    "games",  jam:       "games",
  writing:   "writing",   write:     "writing",   prose:     "writing",
  general:   "general",
};

const PROVIDER_MAP: Record<string, ProviderId> = {
  openai:      "openai",      gpt:       "openai",
  anthropic:   "anthropic",   claude:    "anthropic",
  google:      "google",      gemini:    "google",
  minimax:     "minimax",
  groq:        "groq",
  openrouter:  "openrouter",
};

const MODEL_ALIASES: Record<string, ModelRef> = {
  "gpt-4o":        { provider: "openai",    model: "gpt-4o" },
  "o3":            { provider: "openai",    model: "o3" },
  "o4":            { provider: "openai",    model: "o4-mini" },
  "claude":        { provider: "anthropic", model: "claude-4-sonnet" },
  "claude-sonnet": { provider: "anthropic", model: "claude-4-sonnet" },
  "claude-opus":   { provider: "anthropic", model: "claude-4-opus" },
  "claude-haiku":  { provider: "anthropic", model: "claude-haiku" },
  "gemini":        { provider: "google",    model: "gemini-2.0-flash" },
  "gemini-pro":    { provider: "google",    model: "gemini-2.0-pro" },
  "llama":         { provider: "groq",      model: "llama-3.3-70b" },
  "mixtral":       { provider: "groq",      model: "mixtral-8x7b" },
};

export function extractCategory(raw: string[]): RoomCategory | null {
  const match = raw.find((t) => CATEGORY_MAP[t] !== undefined);
  return match ? CATEGORY_MAP[match] : null;
}

export function extractAccess(raw: string[]): RoomAccess | null {
  const paidWords = ["paid", "charge", "priced", "premium"];
  const freeWords = ["free", "open", "public", "unpaid"];
  if (paidWords.some((w) => raw.includes(w))) return "paid";
  if (freeWords.some((w) => raw.includes(w))) return "free";
  return null;
}

export function extractPrice(raw: string[]): number | null {
  const match = raw.find((t) => {
    const n = parseFloat(t);
    return !isNaN(n) && n > 0 && n < 10_000;
  });
  return match ? parseFloat(match) : null;
}

export function extractRoomId(raw: string[]): RoomId | null {
  return (raw.find((t) => /^rm_[a-zA-Z0-9]{6,}$/.test(t)) as RoomId) ?? null;
}

export function extractReceiptId(raw: string[]): ReceiptId | null {
  return (raw.find((t) => /^rcp_[a-f0-9]{8,}$/.test(t)) as ReceiptId) ?? null;
}

export function extractModel(raw: string[]): { model: ModelRef | null; rawModelName: string } {
  for (let i = 0; i < raw.length - 1; i++) {
    const combined = `${raw[i]}-${raw[i + 1]}`;
    if (MODEL_ALIASES[combined]) {
      return { model: MODEL_ALIASES[combined], rawModelName: combined };
    }
  }

  const aliasMatch = raw.find((t) => MODEL_ALIASES[t] !== undefined);
  if (aliasMatch) return { model: MODEL_ALIASES[aliasMatch], rawModelName: aliasMatch };

  const providerMatch = raw.find((t) => PROVIDER_MAP[t] !== undefined);
  if (providerMatch) return { model: null, rawModelName: providerMatch };

  return { model: null, rawModelName: "" };
}

export { CATEGORY_MAP, PROVIDER_MAP, MODEL_ALIASES };
