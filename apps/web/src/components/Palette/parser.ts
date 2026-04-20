/**
 * parser.ts — Pure function natural-language intent parser for the Palette.
 */

import type { ParseResult, PaletteContext } from "@fatedfortress/protocol";
import { hasSeenPalette, markPaletteSeen } from "../../util/storage.js";
import { tokenizeWithStems } from "./tokenizer.js";
import { scorers, type ScoredIntent } from "./scorers.js";

const CONFIDENCE_THRESHOLD = 0.82;
const AMBIGUITY_MARGIN = 0.15;
const MIN_VIABLE = 0.45;
const MAX_CANDIDATES = 4;

export function parse(input: string, context: PaletteContext): ParseResult {
  if (!input || input.trim().length === 0) {
    if (!hasSeenPalette()) {
      markPaletteSeen(); // persists via safeStorage only when available
      return {
        kind: "candidates",
        candidates: [{
          intent: { type: "help", command: null },
          confidence: 0.99,
          label: "try: /spectate  /join rm_...  /connect  /?",
        }],
      };
    }
    return {
      kind: "error",
      hint: "type a command — try 'create room', 'join rm_...', or '?'",
    };
  }

  const { raw, stems } = tokenizeWithStems(input);

  if (raw.length === 0) {
    return {
      kind: "error",
      hint: "type a command — try 'create room', 'join rm_...', or '?'",
    };
  }

  // Score all intent scorers, catching individual failures
  const results = scorers
    .reduce<ScoredIntent[]>((acc, scorer) => {
      try {
        const result = scorer(raw, stems, context);
        if (result !== null) acc.push(result);
      } catch {
        // individual scorer failure never breaks the Palette
      }
      return acc;
    }, [])
    .sort((a, b) => b.score - a.score);

  if (results.length === 0) {
    return {
      kind: "error",
      hint: `unknown command "${raw[0]}" — type '?' to see all commands`,
    };
  }

  const top    = results[0];
  const second = results[1];

  if (top.score < MIN_VIABLE) {
    return {
      kind: "error",
      hint: `unclear — did you mean '${top.label}'? type '?' for all commands`,
    };
  }

  const isAmbiguous =
    second !== undefined && (top.score - second.score) < AMBIGUITY_MARGIN;

  if (top.score >= CONFIDENCE_THRESHOLD && !isAmbiguous) {
    return {
      kind:       "resolved",
      intent:     top.intent,
      confidence: top.score,
      label:      top.label,
    };
  }

  // Candidates — max MAX_CANDIDATES (UI hard limit)
  return {
    kind: "candidates",
    candidates: results.slice(0, MAX_CANDIDATES).map((r) => ({
      intent:     r.intent,
      confidence: r.score,
      label:      r.label,
    })),
  };
}
