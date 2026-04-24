/**
 * supabase/functions/asset-scanner/index.ts
 *
 * Fated Fortress V2 — Layered Analysis Engine (9 sub-passes)
 *
 * ┌─ Pass 1: Integrity Layer (Deterministic) ──────────────────────────────┐
 * │  1.1 Extension Heuristics   — extMap fast-scan                        │
 * │  1.2 Signature Verification — magic-byte header check                 │
 * │  1.3 Archetype Recognition  — import pattern scan (.ts/.tsx)          │
 * └────────────────────────────────────────────────────────────────────────┘
 * ┌─ Pass 2: Semantic Layer (Heuristic) ───────────────────────────────────┐
 * │  2.1 Graph Extraction       — regex → MermaidNode[]                   │
 * │  2.2 Label Expansion        — GPT-4o resolves ambiguous labels         │
 * │  2.3 Namespace Resolution   — node ID → directory path matching        │
 * └────────────────────────────────────────────────────────────────────────┘
 * ┌─ Pass 3: Orchestration Layer (Gap Analysis) ───────────────────────────┐
 * │  3.1 Hard Gaps              — missing file paths                       │
 * │  3.2 Soft Gaps              — 0-byte or TODO/placeholder files         │
 * │  3.3 Bounty + Spec          — payout_min/max + spec_constraints JSON   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Output: UnitOfWork[] written to Supabase as draft tasks (status = 'draft').
 * spec_constraints is populated so verify-submission can enforce the brief.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DETECTABLE_TYPES = [
  "pr", "code_patch", "file", "design_asset",
  "text", "audio", "video", "3d_model", "figma_link",
] as const;

type DeliverableType = typeof DETECTABLE_TYPES[number];

interface RepoFile {
  path: string;
  size: number;
  content?: string;
}

interface MermaidNode {
  id: string;
  label: string;
  shape?: string;
  resolvedPath?: string;
  expandedLabel?: string;
}

interface SpecConstraints {
  // 3d_model
  max_polygons?:    number;
  requires_rig?:    boolean;
  lod_levels?:      number;
  // audio
  sample_rate?:     number;
  channels?:        number;
  bit_depth?:       number;
  max_duration_s?:  number;
  // design_asset
  max_width?:       number;
  max_height?:      number;
  min_width?:       number;
  min_height?:      number;
  // text
  min_words?:       number;
  max_words?:       number;
  // code_patch
  max_files_changed?: number;
  requires_tests?:  boolean;
}

interface ScannedAsset {
  path: string;
  deliverable_type: DeliverableType;
  context_snippet: string;
  inferred_brief: string;
  confidence: number;
  pass: 1 | 2 | 3;
  sub_pass: string;
  archetype?: string;
  gap_type?: "hard" | "soft";
  payout_min?: number;
  payout_max?: number;
  spec_constraints?: SpecConstraints;  // NEW: populated in Pass 3.3
}

// ---------------------------------------------------------------------------
// Default spec constraints by deliverable type + archetype (Pass 3.3)
// ---------------------------------------------------------------------------

function buildSpecConstraints(
  type: DeliverableType,
  archetype?: string
): SpecConstraints {
  switch (type) {
    case "3d_model": {
      const isCore = archetype === "3D Core Module" || archetype === "3D Asset Import";
      return {
        max_polygons: isCore ? 100_000 : 50_000,
        requires_rig: isCore,
        lod_levels: isCore ? 2 : 1,
      };
    }
    case "audio": {
      const isCore = archetype === "Audio Dependency" || archetype === "Audio Asset Import";
      return {
        sample_rate: isCore ? 44100 : 22050,
        channels: 2,
        bit_depth: 16,
        max_duration_s: 300,
      };
    }
    case "design_asset": {
      const isTexture = archetype === "Texture Import" || archetype === "Texture Dependent";
      return {
        max_width:  isTexture ? 2048 : 4096,
        max_height: isTexture ? 2048 : 4096,
        min_width:  isTexture ? 256  : 512,
        min_height: isTexture ? 256  : 512,
      };
    }
    case "video":        return { max_width: 3840, max_height: 2160, max_duration_s: 300 };
    case "text":         return { min_words: 100, max_words: 10_000 };
    case "code_patch":   return { max_files_changed: 20, requires_tests: false };
    case "pr":           return { max_files_changed: 30, requires_tests: true };
    default:             return {};
  }
}

// ---------------------------------------------------------------------------
// Magic-byte signatures for Pass 1.2
// ---------------------------------------------------------------------------

const MAGIC_BYTES: Record<string, { sig: number[]; type: DeliverableType }> = {
  glb:  { sig: [0x67, 0x6C, 0x54, 0x46], type: "3d_model" },
  gltf: { sig: [0x7B],                    type: "3d_model" },
  png:  { sig: [0x89, 0x50, 0x4E, 0x47], type: "design_asset" },
  jpg:  { sig: [0xFF, 0xD8, 0xFF],        type: "design_asset" },
  mp3:  { sig: [0x49, 0x44, 0x33],        type: "audio" },
  wav:  { sig: [0x52, 0x49, 0x46, 0x46], type: "audio" },
  mp4:  { sig: [0x00, 0x00, 0x00, 0x18], type: "video" },
  pdf:  { sig: [0x25, 0x50, 0x44, 0x46], type: "file" },
};

function checkMagicBytes(ext: string, headerBytes: Uint8Array): { valid: boolean; type: DeliverableType | null } {
  const entry = MAGIC_BYTES[ext];
  if (!entry) return { valid: true, type: null };
  const matches = entry.sig.every((b, i) => headerBytes[i] === b);
  return { valid: matches, type: entry.type };
}

// ---------------------------------------------------------------------------
// Archetype patterns for Pass 1.3
// ---------------------------------------------------------------------------

const ARCHETYPE_PATTERNS: { re: RegExp; archetype: string; weight: number }[] = [
  { re: /useGLTF|useLoader.*GLTFLoader|from\s+['"]@react-three\/fiber['"]/, archetype: "3D Core Module",      weight: 1.5 },
  { re: /useTexture|TextureLoader/,                                           archetype: "Texture Dependent",   weight: 1.2 },
  { re: /useSound|Howl|AudioContext|createBufferSource/,                      archetype: "Audio Dependency",    weight: 1.2 },
  { re: /useVideoTexture|<video|createObjectURL/,                             archetype: "Video Dependent",     weight: 1.1 },
  { re: /import.*from\s+['"][^'"]*\.glb['"]/,                                archetype: "3D Asset Import",     weight: 1.5 },
  { re: /import.*from\s+['"][^'"]*\.mp3['"]/,                                archetype: "Audio Asset Import",  weight: 1.2 },
  { re: /import.*from\s+['"][^'"]*\.png['"]/,                                archetype: "Texture Import",      weight: 1.0 },
];

function detectArchetype(content: string): { archetype: string; weight: number } | null {
  for (const { re, archetype, weight } of ARCHETYPE_PATTERNS) {
    if (re.test(content)) return { archetype, weight };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension map (Pass 1.1)
// ---------------------------------------------------------------------------

const EXT_MAP: Record<string, DeliverableType> = {
  ts: "file", tsx: "file", js: "file", jsx: "file",
  go: "file", rs: "file", py: "file", java: "file",
  css: "file", scss: "file", html: "file", json: "file",
  yml: "file", yaml: "file", toml: "file", sql: "file",
  md: "text", txt: "text", rst: "text",
  png: "design_asset", jpg: "design_asset", jpeg: "design_asset",
  gif: "design_asset", svg: "design_asset", webp: "design_asset",
  figma: "figma_link",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video",
  gltf: "3d_model", glb: "3d_model", obj: "3d_model", fbx: "3d_model",
};

// ---------------------------------------------------------------------------
// Pass 1 — Integrity Layer
// ---------------------------------------------------------------------------

async function pass1(
  files: RepoFile[],
  repoOwner: string,
  repoName: string,
  githubToken: string
): Promise<ScannedAsset[]> {
  const results: ScannedAsset[] = [];

  for (const file of files) {
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    const type = EXT_MAP[ext] ?? "file";

    results.push({
      path: file.path, deliverable_type: type,
      context_snippet: `[1.1] ext: .${ext}`,
      inferred_brief: `Extension scan: ${file.path}`,
      confidence: 0.7, pass: 1, sub_pass: "1.1",
    });

    if (MAGIC_BYTES[ext]) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/main/${file.path}`;
        const res = await fetch(rawUrl, { headers: { Authorization: `Bearer ${githubToken}` } });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const header = new Uint8Array(buf.slice(0, 8));
          const { valid, type: sigType } = checkMagicBytes(ext, header);
          const existing = results.find(r => r.path === file.path && r.sub_pass === "1.1");
          if (existing) {
            if (!valid) {
              existing.confidence = 0.2;
              existing.context_snippet += ` | [1.2] ⚠ Magic-byte MISMATCH`;
              existing.gap_type = "soft";
            } else if (sigType) {
              existing.confidence = 0.95;
              existing.context_snippet += ` | [1.2] ✓ Signature verified`;
              existing.sub_pass = "1.2";
            }
          }
        }
      } catch { /* skip */ }
    }

    if ((ext === "ts" || ext === "tsx") && file.content) {
      const arc = detectArchetype(file.content);
      if (arc) {
        const existing = results.find(r => r.path === file.path);
        if (existing) {
          existing.archetype = arc.archetype;
          existing.confidence = Math.min(1, existing.confidence * arc.weight);
          existing.context_snippet += ` | [1.3] Archetype: ${arc.archetype}`;
          existing.sub_pass = "1.3";
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pass 2 — Semantic Layer
// ---------------------------------------------------------------------------

function extractMermaidNodes(mermaidText: string): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  const seen = new Set<string>();
  const nodeRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(mermaidText)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = (m[2] ?? m[3] ?? m[4] ?? id).replace(/<br\/?>/gi, " ").replace(/"/g, "").trim();
    nodes.push({ id, label, shape: m[0] });
  }
  return nodes;
}

async function expandLabelsWithLLM(
  nodes: MermaidNode[], readmeContext: string, openaiKey: string
): Promise<MermaidNode[]> {
  if (!openaiKey || nodes.length === 0) return nodes;
  const ambiguous = nodes.filter(n => n.label.split(" ").length <= 2 || /character|asset|module|item|component|resource/i.test(n.label));
  if (ambiguous.length === 0) return nodes;
  const prompt = `You are a creative director analyzing a software architecture diagram.
Given these ambiguous node labels from a Mermaid diagram and the project README context,
resolve each label to its most likely creative asset type and write a 1-sentence description.

README context (first 800 chars):
${readmeContext.slice(0, 800)}

Nodes to resolve (JSON array of {id, label}):
${JSON.stringify(ambiguous.map(n => ({ id: n.id, label: n.label })))}

Respond ONLY with a JSON array: [{id, expandedLabel, deliverableType}]
where deliverableType is one of: file, design_asset, audio, video, 3d_model, text, figma_link, pr, code_patch`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: "gpt-4o", messages: [{ role: "user", content: prompt }],
        temperature: 0.2, max_tokens: 800, response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return nodes;
    const json = await res.json() as { choices: { message: { content: string } }[] };
    const raw = JSON.parse(json.choices[0].message.content);
    const expansions: { id: string; expandedLabel: string }[] = Array.isArray(raw) ? raw : (raw.nodes ?? raw.result ?? []);
    return nodes.map(n => { const exp = expansions.find(e => e.id === n.id); return exp ? { ...n, expandedLabel: exp.expandedLabel } : n; });
  } catch { return nodes; }
}

function resolveNamespace(nodes: MermaidNode[], allPaths: Set<string>): MermaidNode[] {
  return nodes.map(node => {
    const candidates = [node.id, node.id.replace(/_/g, "-"), node.id.replace(/_/g, "/"), node.id.toLowerCase(), node.id.toLowerCase().replace(/_/g, "-")];
    const suffixMatch = [...allPaths].find(p => candidates.some(c => p.endsWith(c) || p.endsWith(`${c}.ts`) || p.endsWith(`${c}.tsx`)));
    return { ...node, resolvedPath: suffixMatch };
  });
}

async function pass2(
  mermaidText: string, allPaths: Set<string>, readmeContext: string, openaiKey: string
): Promise<{ assets: ScannedAsset[]; nodes: MermaidNode[] }> {
  let nodes = extractMermaidNodes(mermaidText);
  nodes = await expandLabelsWithLLM(nodes, readmeContext, openaiKey);
  nodes = resolveNamespace(nodes, allPaths);
  const assets: ScannedAsset[] = nodes.map(node => ({
    path: node.resolvedPath ?? `DIAGRAM:${node.id}`,
    deliverable_type: "file",
    context_snippet: `[2.1] Node: "${node.label}"${node.expandedLabel ? ` | [2.2] Expanded: "${node.expandedLabel}"` : ""}${node.resolvedPath ? ` | [2.3] Resolved: ${node.resolvedPath}` : ""}`,
    inferred_brief: node.expandedLabel ?? `Diagram node "${node.label}" — no expansion available`,
    confidence: node.resolvedPath ? 0.8 : 0.45,
    pass: 2, sub_pass: node.resolvedPath ? "2.3" : node.expandedLabel ? "2.2" : "2.1",
  }));
  return { assets, nodes };
}

// ---------------------------------------------------------------------------
// Pass 3 — Orchestration Layer
// ---------------------------------------------------------------------------

const PLACEHOLDER_MARKERS = [
  /\/\/\s*TODO/i, /\/\/\s*FIXME/i, /\/\/\s*placeholder/i,
  /\/\*\s*stub\s*\*\//i, /console\.warn.*placeholder/i,
  /throw new Error\("not implemented"\)/i,
];

const PAYOUT_TABLE: Record<string, { min: number; max: number }> = {
  "3d_model":    { min: 40,  max: 200 },
  "audio":       { min: 20,  max: 100 },
  "video":       { min: 60,  max: 300 },
  "design_asset":{ min: 10,  max: 80  },
  "code_patch":  { min: 30,  max: 150 },
  "text":        { min: 5,   max: 40  },
  "figma_link":  { min: 20,  max: 120 },
  "pr":          { min: 30,  max: 200 },
  "file":        { min: 10,  max: 60  },
};

const ARCHETYPE_PAYOUT_MULTIPLIER: Record<string, number> = {
  "3D Core Module":    2.0,
  "Audio Dependency":  1.5,
  "Video Dependent":   1.8,
  "3D Asset Import":   1.8,
  "Audio Asset Import":1.5,
  "Texture Import":    1.2,
  "Texture Dependent": 1.2,
};

async function pass3(
  mermaidNodes: MermaidNode[],
  allFiles: RepoFile[],
  allPaths: Set<string>,
  pass1Assets: ScannedAsset[]
): Promise<ScannedAsset[]> {
  const results: ScannedAsset[] = [];

  // 3.1 — Hard gaps
  for (const node of mermaidNodes) {
    if (node.resolvedPath) continue;
    const candidates = [node.id, node.id.replace(/_/g, "-"), node.id.replace(/_/g, "/")];
    if (!candidates.some(c => allPaths.has(c))) {
      results.push({
        path: `GAP:${node.id}`,
        deliverable_type: "file",
        context_snippet: `[3.1] Hard gap — diagram declares "${node.id}" but no implementation found`,
        inferred_brief: node.expandedLabel ?? `Architecture declares "${node.label}" but no file exists`,
        confidence: 0.85, pass: 3, sub_pass: "3.1", gap_type: "hard",
      });
    }
  }

  // 3.2 — Soft gaps
  for (const file of allFiles) {
    if (file.size === 0) {
      results.push({
        path: file.path,
        deliverable_type: EXT_MAP[file.path.split(".").pop()?.toLowerCase() ?? ""] ?? "file",
        context_snippet: `[3.2] Soft gap — file exists but is 0 bytes`,
        inferred_brief: `Empty file placeholder at ${file.path} — requires real implementation`,
        confidence: 0.9, pass: 3, sub_pass: "3.2", gap_type: "soft",
      });
      continue;
    }
    const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
    if (["ts", "tsx", "js", "jsx", "md", "txt"].includes(ext) && file.content) {
      if (PLACEHOLDER_MARKERS.some(re => re.test(file.content!))) {
        results.push({
          path: file.path,
          deliverable_type: EXT_MAP[ext] ?? "file",
          context_snippet: `[3.2] Soft gap — file contains TODO/placeholder markers`,
          inferred_brief: `${file.path} is a stub — contains unimplemented sections`,
          confidence: 0.75, pass: 3, sub_pass: "3.2", gap_type: "soft",
        });
      }
    }
  }

  // 3.3 — Bounty calculation + spec_constraints population
  for (const gap of results) {
    const base = PAYOUT_TABLE[gap.deliverable_type] ?? PAYOUT_TABLE["file"];
    const archetypeAsset = pass1Assets.find(a => a.path === gap.path && a.archetype);
    const multiplier = archetypeAsset?.archetype ? (ARCHETYPE_PAYOUT_MULTIPLIER[archetypeAsset.archetype] ?? 1.0) : 1.0;
    gap.payout_min = Math.round(base.min * multiplier);
    gap.payout_max = Math.round(base.max * multiplier);
    // Build spec_constraints from type + archetype so verify-submission can enforce the brief
    gap.spec_constraints = buildSpecConstraints(gap.deliverable_type, archetypeAsset?.archetype);
    if (archetypeAsset?.archetype) {
      gap.archetype = archetypeAsset.archetype;
      gap.context_snippet += ` | [3.3] Bounty: $${gap.payout_min}–$${gap.payout_max} (archetype: ${archetypeAsset.archetype}) | spec: ${JSON.stringify(gap.spec_constraints)}`;
    } else {
      gap.context_snippet += ` | [3.3] Bounty: $${gap.payout_min}–$${gap.payout_max} | spec: ${JSON.stringify(gap.spec_constraints)}`;
    }
    gap.sub_pass = "3.3";
  }

  return results;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function fetchRepoTree(owner: string, repo: string, ref: string, token: string): Promise<{ path: string; size: number }[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) return [];
  const json = await res.json() as { tree: { path: string; size: number; type: string }[] };
  return (json.tree ?? []).filter(f => f.type === "blob");
}

async function fetchFileContent(owner: string, repo: string, path: string, token: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const json = await res.json() as { content?: string; encoding?: string };
  if (json.encoding === "base64" && json.content) {
    try { return atob(json.content.replace(/\n/g, "")); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main scanner entry point
// ---------------------------------------------------------------------------

async function runScanner(
  repoOwner: string, repoName: string, repoRef: string,
  mermaidContent: string, readmeContext: string,
  githubToken: string, openaiKey: string
): Promise<ScannedAsset[]> {

  const treeItems = await fetchRepoTree(repoOwner, repoName, repoRef, githubToken);
  const allPaths  = new Set(treeItems.map(f => f.path));

  const repoFiles: RepoFile[] = await Promise.all(
    treeItems.map(async (item) => {
      const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
      const needsContent = ["ts", "tsx", "js", "jsx", "md"].includes(ext);
      const content = needsContent ? await fetchFileContent(repoOwner, repoName, item.path, githubToken) : undefined;
      return { path: item.path, size: item.size, content: content ?? undefined };
    })
  );

  const p1 = await pass1(repoFiles, repoOwner, repoName, githubToken);
  const { assets: p2, nodes: mermaidNodes } = await pass2(mermaidContent, allPaths, readmeContext, openaiKey);
  const p3 = await pass3(mermaidNodes, repoFiles, allPaths, p1);

  return [...p1, ...p2, ...p3];
}

// ---------------------------------------------------------------------------
// Deno HTTP handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const auth = await resolveAuth(req);
  if (auth.kind !== "user" && auth.kind !== "service") {
    return new Response("Unauthorized", { status: 401 });
  }

  const {
    repoOwner, repoName, repoRef = "main", projectId, mermaidContent: bodyMermaid,
  } = await req.json() as {
    repoOwner?: string; repoName?: string; repoRef?: string;
    projectId?: string; mermaidContent?: string;
  };

  if (!repoOwner || !repoName) {
    return Response.json({ error: "repoOwner and repoName are required" }, { status: 400 });
  }

  const githubToken = Deno.env.get("GITHUB_TOKEN") ?? "";
  const openaiKey   = Deno.env.get("OPENAI_API_KEY") ?? "";
  const sb          = serviceRoleClient();

  let mermaidContent = bodyMermaid ?? "";
  let readmeContext  = "";
  if (projectId) {
    const { data: project } = await sb.from("projects").select("readme_draft, description").eq("id", projectId).single();
    const p = project as Record<string, string> | null;
    if (p?.readme_draft && !mermaidContent) mermaidContent = p.readme_draft;
    if (p?.description) readmeContext = p.description;
  }

  const assets = await runScanner(repoOwner, repoName, repoRef, mermaidContent, readmeContext, githubToken, openaiKey);
  const gaps   = assets.filter(a => a.pass === 3 || a.path.startsWith("GAP:") || a.path.startsWith("DIAGRAM:"));

  // Write gaps as draft tasks via asset_scanner_write RPC (service-role only)
  let inserted = 0;
  if (projectId && gaps.length > 0) {
    const { data, error } = await sb.rpc("asset_scanner_write", {
      p_project_id: projectId,
      p_tasks: gaps.map(g => ({
        path:             g.path.replace(/^(GAP:|DIAGRAM:)/, ""),
        deliverable_type: g.deliverable_type,
        context_snippet:  g.context_snippet,
        inferred_brief:   g.inferred_brief,
        expected_path:    g.path.replace(/^(GAP:|DIAGRAM:)/, ""),
        payout_min:       g.payout_min ?? 10,
        payout_max:       g.payout_max ?? 60,
        ambiguity_score:  parseFloat((1 - g.confidence).toFixed(2)),
        spec_constraints: g.spec_constraints ?? {},
      })),
    });
    if (error) console.error("asset_scanner_write error:", error);
    inserted = typeof data === "number" ? data : 0;
  }

  return Response.json({
    success: true,
    summary: {
      pass1: assets.filter(a => a.pass === 1).length,
      pass2: assets.filter(a => a.pass === 2).length,
      pass3_gaps: gaps.length,
      hard_gaps: gaps.filter(a => a.gap_type === "hard").length,
      soft_gaps: gaps.filter(a => a.gap_type === "soft").length,
      draft_tasks_written: inserted,
    },
    assets,
  });
});
