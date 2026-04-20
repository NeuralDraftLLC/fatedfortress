/**
 * commandTrie.ts — Prefix tree over palette command strings (Phase 4 Task 1).
 *
 * Built on each palette open from context-aware vocabulary. `complete()` returns the longest
 * common prefix extension among terminals under the typed prefix (Tab advances to branch point).
 */

import type { PaletteContext } from "@fatedfortress/protocol";

/** Per-character edges; terminals mark full phrase ends (ghost uses scan+LCP for case-insensitive prefix). */
interface TrieNode {
  children: Map<string, TrieNode>;
  terminal: boolean;
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let pref = strings[0];
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i];
    let j = 0;
    while (
      j < pref.length &&
      j < s.length &&
      pref[j]!.toLowerCase() === s[j]!.toLowerCase()
    ) {
      j++;
    }
    pref = pref.slice(0, j);
    if (pref.length === 0) return "";
  }
  return pref;
}

/** Flatten trie — all inserted terminal strings. */
function collectAll(node: TrieNode, prefix: string, acc: string[]): void {
  if (node.terminal) acc.push(prefix);
  for (const [ch, child] of node.children) {
    collectAll(child, prefix + ch, acc);
  }
}

export function buildVocabulary(ctx: PaletteContext): string[] {
  // Static phrases aligned with parser intents — keep labels stable for Tab completion UX.
  const phrases: string[] = [
    "show available commands",
    "help",
    "?",
    "create general room (free)",
    "open /connect docs",
    "open /me receipts vault",
    "browse general rooms",
    "link here.now account for permanent publishing",
    "set participant token quota",
    "delegate sub-budget (select peer)",
  ];

  if (ctx.currentRoomId) {
    // Room-scoped routes — mirror spectate/join/publish fork paths from scorers.ts.
    phrases.push(`join ${ctx.currentRoomId}`);
    phrases.push(`spectate ${ctx.currentRoomId}`);
    phrases.push("spectate this room");
    phrases.push("publish room to here.now");
    phrases.push("publish receipt to here.now");
    phrases.push("fork current receipt");
    phrases.push("upgrade room to paid");
    phrases.push("set system prompt (type the prompt value)");
  }

  if (ctx.currentRoomAccess === "paid" && ctx.currentRoomId) {
    phrases.push("pay to join room");
    phrases.push(`pay USDC to join room`);
  }

  if (ctx.currentModel) {
    phrases.push(`switch to ${ctx.currentModel.provider}/${ctx.currentModel.model}`);
  }

  return [...new Set(phrases)];
}

export class CommandTrie {
  private root: TrieNode = { children: new Map(), terminal: false };

  constructor(strings: Iterable<string>) {
    for (const s of strings) this.insert(s);
  }

  private insert(raw: string): void {
    const s = raw.trim();
    if (!s) return;
    let node = this.root;
    for (const ch of s) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map(), terminal: false };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.terminal = true;
  }

  /**
   * Longest ghost suffix: extension after `typed` equal to LCP(matches) minus the overlapping
   * prefix with `typed` (case-insensitive prefix match).
   */
  complete(typed: string): string {
    const all: string[] = [];
    collectAll(this.root, "", all);
    const tl = typed.toLowerCase();
    const matches = all.filter((s) => s.toLowerCase().startsWith(tl));
    if (matches.length === 0) return "";

    const pref = longestCommonPrefix(matches);
    let i = 0;
    while (
      i < typed.length &&
      i < pref.length &&
      typed[i]!.toLowerCase() === pref[i]!.toLowerCase()
    ) {
      i++;
    }
    return pref.slice(i);
  }
}

export function buildCommandTrie(ctx: PaletteContext): CommandTrie {
  return new CommandTrie(buildVocabulary(ctx));
}
