import type { PaletteIntent, PaletteContext } from "@fatedfortress/protocol";
import { includesAny } from "./tokenizer.js";
import {
  CATEGORY_MAP,
  PROVIDER_MAP,
  extractCategory,
  extractAccess,
  extractPrice,
  extractRoomId,
  extractReceiptId,
  extractModel,
} from "./extractors.js";

export const S = {
  CREATE_BASE:       0.55,
  CREATE_VERB:       0.10,
  CREATE_NOUN:       0.08,
  CREATE_CATEGORY:   0.10,
  CREATE_ACCESS:     0.04,
  CREATE_PRICE:      0.08,
  CREATE_MAX:        0.91,

  JOIN_WITH_VERB:    0.96,
  JOIN_NO_VERB:      0.85,

  FORK_WITH_ID:      0.93,
  FORK_NO_ID:        0.74,

  SWITCH_WITH_MODEL: 0.91,
  SWITCH_PROVIDER:   0.70,

  PUBLISH:           0.88,

  PAY_WITH_AMOUNT:   0.90,
  PAY_NO_AMOUNT:     0.72,

  INVITE_WITH_PEER:  0.86,
  INVITE_NO_PEER:    0.68,

  SEARCH_WITH_QUERY: 0.82,
  SEARCH_NO_QUERY:   0.71, // raised from 0.61 when category is found

  LINK_BOTH:         0.91,
  LINK_ONE:          0.65,

  SYS_PROMPT_VALUE:  0.83,
  SYS_PROMPT_EMPTY:  0.60,

  QUOTA_VALUE:       0.84,
  QUOTA_EMPTY:       0.60,

  CONNECT:           0.80,
  ME:                0.78,
  HELP:              0.75,
  HELP_EXACT:        0.95, // bare "?" or "help"
} as const;

export interface ScoredIntent {
  score:  number;
  intent: PaletteIntent;
  label:  string;
}

export type IntentScorer = (raw: string[], stems: string[], context: PaletteContext) => ScoredIntent | null;

export const scorers: IntentScorer[] = [

  // ── help ──────────────────────────────────────────────────────────────────
  (raw, stems) => {
    const isBareLiteral = raw.length === 1 && (raw[0] === "?" || raw[0] === "help");

    // Resolves immediately at high confidence if the input is exactly "?" or "help"
    if (isBareLiteral) {
      return {
        score:  S.HELP_EXACT,
        intent: { type: "help", command: null },
        label:  "show available commands",
      };
    }

    if (!includesAny(raw, stems, ["help", "?", "how", "what", "commands"] as const)) return null;

    const CMD_WORDS = new Set(["help", "?", "how", "what", "do", "i", "can", "commands", "show", "list"]);
    const command   = raw.find((t) => !CMD_WORDS.has(t)) ?? null;

    return {
      score:  S.HELP,
      intent: { type: "help", command },
      label:  command ? `help: ${command}` : "show available commands",
    };
  },

  // ── create_room ───────────────────────────────────────────────────────────
  (raw, stems) => {
    const verbWords = ["create", "new", "make", "open", "start", "build"] as const;
    const nounWords = ["room", "channel", "space", "session"]             as const;
    const hasVerb     = includesAny(raw, stems, verbWords);
    const hasNoun     = includesAny(raw, stems, nounWords);
    const category    = extractCategory(raw);
    const hasCategory = category !== null;

    // Require at least two signals: (verb+noun) OR (verb+category) OR (category+noun)
    const signals = (hasVerb ? 1 : 0) + (hasNoun ? 1 : 0) + (hasCategory ? 1 : 0);
    if (signals < 2) return null;

    // FIX: use extractAccess with "pay" removed from its verb set
    const access = extractAccess(raw) ?? "free";
    const price  = extractPrice(raw);

    let score = S.CREATE_BASE;
    if (hasVerb)               score += S.CREATE_VERB;
    if (hasNoun)               score += S.CREATE_NOUN;
    if (hasCategory)           score += S.CREATE_CATEGORY;
    if (access !== null)       score += S.CREATE_ACCESS;
    if (access === "paid" && price) score += S.CREATE_PRICE;

    return {
      score: Math.min(score, S.CREATE_MAX),
      intent: {
        type:     "create_room",
        category: category ?? "general",
        access,
        price:    access === "paid" ? (price ?? null) : null,
        name:     null,
      },
      label: `create ${category ?? "general"} room (${access}${price ? ` $${price}` : ""})`,
    };
  },

  // ── join_room ─────────────────────────────────────────────────────────────
  (raw, stems) => {
    const roomId = extractRoomId(raw);
    if (!roomId) return null;
    const hasVerb = includesAny(raw, stems, ["join", "go", "open", "enter", "load"] as const);
    return {
      score:  hasVerb ? S.JOIN_WITH_VERB : S.JOIN_NO_VERB,
      intent: { type: "join_room", roomId },
      label:  `join ${roomId}`,
    };
  },

  // ── fork_receipt ──────────────────────────────────────────────────────────
  (raw, stems, context) => {
    if (!includesAny(raw, stems, ["fork", "branch", "remix", "clone"] as const)) return null;
    const receiptId = extractReceiptId(raw) ?? context.focusedReceiptId;
    return {
      score:  receiptId ? S.FORK_WITH_ID : S.FORK_NO_ID,
      intent: { type: "fork_receipt", receiptId },
      label:  receiptId ? `fork ${receiptId}` : "fork current receipt",
    };
  },

  // ── switch_model ──────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["switch", "use", "change", "model", "with"] as const)) return null;
    const { model, rawModelName } = extractModel(raw);
    if (!rawModelName) return null;
    return {
      score:  model ? S.SWITCH_WITH_MODEL : S.SWITCH_PROVIDER,
      intent: { type: "switch_model", model, rawModelName },
      label:  model
        ? `switch to ${model.provider}/${model.model}`
        : `switch model: "${rawModelName}" (select variant)`,
    };
  },

  // ── publish ───────────────────────────────────────────────────────────────
  (raw, stems, context) => {
    if (!includesAny(raw, stems, ["publish", "ship", "deploy", "push", "release"] as const)) return null;
    const target: "room" | "receipt" =
      includesAny(raw, stems, ["receipt", "rcp"] as const) || context.currentPage !== "room"
        ? "receipt"
        : "room";
    return {
      score:  S.PUBLISH,
      intent: { type: "publish", target },
      label:  `publish ${target} to here.now`,
    };
  },

  // ── pay ───────────────────────────────────────────────────────────────────
  (raw, stems, context) => {
    if (!includesAny(raw, stems, ["pay", "buy", "purchase", "unlock", "access"] as const)) return null;
    // FIX: use ?? operator for correct null coalescence (was incorrectly using ? ternary)
    const roomId     = extractRoomId(raw) ?? context.currentRoomId;
    const isPaidCtx  = context.currentRoomAccess === "paid";
    if (!roomId && !isPaidCtx) return null;
    const amount = extractPrice(raw);
    return {
      score:  amount ? S.PAY_WITH_AMOUNT : S.PAY_NO_AMOUNT,
      intent: { type: "pay", amount: amount ?? 0, roomId },
      label:  `pay${amount ? ` $${amount} USDC` : ""} to join room`,
    };
  },

  // ── invite ────────────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["invite", "add", "share", "bring"] as const)) return null;
    const peer = raw.find((t) => t.startsWith("@")) ?? null;
    return {
      score:  peer ? S.INVITE_WITH_PEER : S.INVITE_NO_PEER,
      intent: { type: "invite", peer },
      label:  peer ? `invite ${peer}` : "open invite dialog",
    };
  },

  // ── search ────────────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["search", "find", "browse", "look", "list"] as const)) return null;
    const category = extractCategory(raw);

    // FIX: positional slice — don't strip words from query by denylist
    const cmdIdx = raw.findIndex((t) =>
      ["search", "find", "browse", "look", "list"].includes(t)
    );
    const afterCmd   = raw.slice(cmdIdx + 1);
    const queryWords = afterCmd.filter((t) => !CATEGORY_MAP[t] && t !== "rooms" && t !== "room");
    const query      = queryWords.join(" ");

    // FIX: score higher when category found even with empty query
    const score = query.length > 0
      ? S.SEARCH_WITH_QUERY
      : category
        ? S.SEARCH_NO_QUERY  // raised: category IS the search criterion
        : 0.55;

    return {
      score,
      intent: { type: "search", query, category },
      label:  category
        ? `browse ${category} rooms${query ? `: "${query}"` : ""}`
        : `search rooms: "${query}"`,
    };
  },

  // ── link_herenow ──────────────────────────────────────────────────────────
  (raw, stems, context) => {
    if (context.herenowLinked) return null;
    const hasLink   = includesAny(raw, stems, ["link", "connect", "attach", "bind"] as const);
    const hasTarget = includesAny(raw, stems, ["here.now", "herenow", "account", "permanent", "storage"] as const);
    if (!hasLink && !hasTarget) return null;
    return {
      score:  hasLink && hasTarget ? S.LINK_BOTH : S.LINK_ONE,
      intent: { type: "link_herenow" },
      label:  "link here.now account for permanent publishing",
    };
  },

  // ── set_system_prompt ─────────────────────────────────────────────────────
  (raw, stems) => {
    const hasSysWord  = includesAny(raw, stems, ["system", "persona", "instructions"] as const);
    const hasPrompt   = includesAny(raw, stems, ["prompt"]                           as const);
    const hasSetVerb  = includesAny(raw, stems, ["set", "change", "update", "use"]  as const);
    if (!(hasSysWord || hasPrompt) || !hasSetVerb) return null;

    // FIX: positional slice — find the end of command tokens, take everything after.
    // This preserves words like "system" and "prompt" IF they appear in the value.
    const CMD_TOKENS = new Set(["set", "change", "update", "use", "system", "prompt", "persona", "to", "as", "instructions"]);
    const firstValueIdx = raw.findIndex((t, i) => i > 0 && !CMD_TOKENS.has(t));
    const prompt = firstValueIdx >= 0
      ? raw.slice(firstValueIdx).join(" ")
      : "";

    return {
      score:  prompt.length > 2 ? S.SYS_PROMPT_VALUE : S.SYS_PROMPT_EMPTY,
      intent: { type: "set_system_prompt", prompt },
      label:  prompt.length > 0
        ? `set system prompt: "${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}"`
        : "set system prompt (type the prompt value)",
    };
  },

  // ── set_quota ─────────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["quota", "limit", "allowance", "budget"] as const)) return null;
    const tokensPerUser = extractPrice(raw) ?? 0;
    return {
      score:  tokensPerUser > 0 ? S.QUOTA_VALUE : S.QUOTA_EMPTY,
      intent: { type: "set_quota", tokensPerUser: Math.floor(tokensPerUser) },
      label:  tokensPerUser > 0
        ? `set quota: ${tokensPerUser} tokens/user/hour`
        : "set participant token quota",
    };
  },

  // ── open_connect ──────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["docs", "connect", "reference", "api", "examples"] as const)) return null;
    const providerToken = raw.find((t) => t in PROVIDER_MAP);
    const provider      = providerToken ? PROVIDER_MAP[providerToken] : null;
    return {
      score:  S.CONNECT,
      intent: { type: "open_connect", provider: provider ?? null },
      label:  provider ? `open /connect docs (${provider})` : "open /connect docs",
    };
  },

  // ── open_me ───────────────────────────────────────────────────────────────
  (raw, stems) => {
    if (!includesAny(raw, stems, ["receipts", "history", "me", "my", "earnings", "vault"] as const)) return null;
    return {
      score:  S.ME,
      intent: { type: "open_me" },
      label:  "open /me receipts vault",
    };
  },

];
