/**
 * supabase/functions/asset-scanner/index.ts
 *
 * Fated Fortress V2 — The Scanner is the moat.
 *
 * Prototype scope: FatedFortress repo itself (one domain).
 * Dogfood: Feed this repo's own Mermaid diagram; use gaps as pitch artifact.
 *
 * Pass 1 — Deterministic (name + extension heuristics)
 * Pass 2 — Heuristic  (Mermaid digraph / README patterns)
 * Pass 3 — Gap analysis  (compare Mermaid nodes against actual files)
 *
 * Output: Array of ScannedAsset objects with deliverable_type, context_snippet,
 * inferred_brief, and expected_path. Written to Supabase as draft tasks (not published).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const DETECTABLE_TYPES = [
  "pr", "code_patch", "file", "design_asset",
  "text", "audio", "video", "3d_model", "figma_link",
] as const;

type DeliverableType = typeof DETECTABLE_TYPES[number];

interface ScannedAsset {
  path: string;
  deliverable_type: DeliverableType;
  context_snippet: string;
  inferred_brief: string;
  confidence: number; // 0–1
  pass: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Pass 1 — Deterministic heuristics (extension + path patterns)
// ---------------------------------------------------------------------------

function pass1_deterministic(rootFiles: string[]): ScannedAsset[] {
  const results: ScannedAsset[] = [];

  const extMap: Record<string, DeliverableType> = {
    ts: "file", tsx: "file", js: "file", jsx: "file",
    go: "file", rs: "file", py: "file", java: "file",
    css: "file", scss: "file", html: "file", json: "file",
    yml: "file", yaml: "file", toml: "file", sql: "file",
    // Source code
    md: "text", txt: "text", rst: "text",
    // Docs / text
    png: "design_asset", jpg: "design_asset", jpeg: "design_asset",
    gif: "design_asset", svg: "design_asset", webp: "design_asset",
    figma: "figma_link",
    // Design assets
    mp3: "audio", wav: "audio", ogg: "audio", flac: "audio",
    mp4: "video", mov: "video", webm: "video", mkv: "video",
    gltf: "3d_model", glb: "3d_model", obj: "3d_model", fbx: "3d_model",
    // 3d
  };

  const pathFlags: [RegExp, DeliverableType][] = [
    [/supabase[/\\]migrations/, "pr"],
    [/^migrations\//, "pr"],
    [/\.test\.|\.spec\./, "file"],
    [/\b(README|CONTRIBUTING|LICENSE|Changelog)\b/i, "text"],
    [/design|ui|assets?/, "design_asset"],
    [/pr|pull.?request/i, "pr"],
    [/\.fig\./i, "figma_link"],
    [/schema|sql/, "pr"],
  ];

  for (const file of rootFiles) {
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    const type = extMap[ext] ?? "file";

    // Path-based overrides
    for (const [re, ovType] of pathFlags) {
      if (re.test(file)) {
        results.push({
          path: file,
          deliverable_type: ovType,
          context_snippet: `[Pass 1] Extension/pattern match: ${ext}`,
          inferred_brief: `Deterministic scan: ${file}`,
          confidence: 0.95,
          pass: 1,
        });
        break;
      }
    }

    if (type !== "file" || results.some(r => r.path === file)) continue;
    results.push({
      path: file,
      deliverable_type: type,
      context_snippet: `[Pass 1] Extension: .${ext}`,
      inferred_brief: `Deterministic scan: ${file}`,
      confidence: 0.7,
      pass: 1,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pass 2 — Heuristic: Mermaid diagram / README parsing
// ---------------------------------------------------------------------------

interface MermaidNode {
  id: string;
  label: string;
  shape?: string;
}

function parseMermaidDiagram(mermaidText: string): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  // Match: nodeId[label] or nodeId(label) or nodeId[[label]] etc.
  const nodeRe = /([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]|\1\(([^\)]+)\)|1\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(mermaidText)) !== null) {
    const id = m[1] ?? m[4] ?? "unknown";
    const label = m[2] ?? m[3] ?? m[4] ?? id;
    nodes.push({ id, label, shape: m[0] });
  }
  // Also match classDef / style nodes
  const classDefRe = /classDef\s+(\w+)/g;
  while ((m = classDefRe.exec(mermaidText)) !== null) {
    nodes.push({ id: m[1], label: m[1], shape: "classDef" });
  }
  return nodes;
}

function pass2_mermaid(
  mermaidText: string,
  existingPaths: Set<string>
): ScannedAsset[] {
  const results: ScannedAsset[] = [];
  const nodes = parseMermaidDiagram(mermaidText);

  const labelTypeHints: [string[], DeliverableType][] = [
    [["storage", "upload", "presigned", "file"], "file"],
    [["payment", "stripe", "checkout"], "file"],
    [["auth", "login", "session", "jwt"], "file"],
    [["db", "schema", "sql", "migration"], "pr"],
    [["task", "claim", "worker", "queue"], "file"],
    [["api", "endpoint", "route", "handler"], "file"],
    [["ui", "component", "page", "view"], "design_asset"],
    [["test", "spec", "verify"], "file"],
    [["doc", "readme", "changelog"], "text"],
    [["github", "oauth", "callback"], "file"],
  ];

  for (const node of nodes) {
    const nodeLabelLower = node.label.toLowerCase();
    let bestMatch: DeliverableType = "file";
    let bestHint = "";
    for (const [keywords, dtype] of labelTypeHints) {
      if (keywords.some(k => nodeLabelLower.includes(k))) {
        bestMatch = dtype;
        bestHint = keywords.join(", ");
        break;
      }
    }

    // Check if a corresponding file exists in the repo
    const candidatePaths = [
      node.id,
      node.id.replace(/_/g, "-"),
      node.id.replace(/_/g, "/"),
    ];
    const matched = candidatePaths.find(p => existingPaths.has(p));
    const path = matched ?? `MISSING:${node.id}`;

    results.push({
      path,
      deliverable_type: bestMatch,
      context_snippet: `[Pass 2] Mermaid node: "${node.label}" (hints: ${bestHint || "none"})`,
      inferred_brief: `Heuristic scan of Mermaid node "${node.label}" — ${node.shape ?? "node"}`,
      confidence: matched ? 0.75 : 0.4,
      pass: 2,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pass 3 — Gap analysis: Mermaid nodes without files vs files without Mermaid
// ---------------------------------------------------------------------------

function pass3_gap_analysis(
  mermaidNodes: MermaidNode[],
  allPaths: Set<string>
): ScannedAsset[] {
  const results: ScannedAsset[] = [];

  const knownNodes = new Set(mermaidNodes.map(n => n.id));

  // Gap A: Mermaid node exists but no corresponding file
  for (const node of mermaidNodes) {
    const candidatePaths = [node.id, node.id.replace(/_/g, "-"), node.id.replace(/_/g, "/")];
    if (!candidatePaths.some(p => allPaths.has(p))) {
      results.push({
        path: `GAP:${node.id}`,
        deliverable_type: "file",
        context_snippet: `[Pass 3] Mermaid references "${node.id}" but no file found`,
        inferred_brief: `Gap: architecture declares "${node.label}" but implementation missing`,
        confidence: 0.3,
        pass: 3,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main scanner entry point
// ---------------------------------------------------------------------------

async function runScanner(
  supabase: ReturnType<typeof createClient>,
  repoUrl: string,
  mermaidContent: string
): Promise<ScannedAsset[]> {
  // In a real implementation, we would:
  // 1. Clone or fetch the repo contents via GitHub API
  // 2. Walk the file tree to get all file paths
  // For the prototype, we use a simulated file list and focus on the logic.
  const mockFiles = [
    "supabase/schema.sql",
    "supabase/migrations/20250421_post_refactor_v1.sql",
    "supabase/migrations/20260422_persist_blueprint.sql",
    "apps/web/src/pages/tasks.ts",
    "apps/web/src/pages/submit.ts",
    "apps/web/src/handlers/payout.ts",
    "apps/web/src/net/storage.ts",
    "diagrams/architecture.md",
    "README.md",
    "supabase/functions/stripe-payment/index.ts",
    "supabase/functions/create-payment-intent/index.ts",
    "supabase/functions/auto-release/index.ts",
    "supabase/functions/expire-claims/index.ts",
  ];

  const allPaths = new Set(mockFiles);
  const rootFiles = mockFiles;

  // Pass 1: deterministic
  const pass1Results = pass1_deterministic(rootFiles);

  // Pass 2: Mermaid parsing
  const pass2Results = pass2_mermaid(mermaidContent ?? "", allPaths);

  // Pass 3: gap analysis
  const mermaidNodes = parseMermaidDiagram(mermaidContent ?? "");
  const pass3Results = pass3_gap_analysis(mermaidNodes, allPaths);

  return [...pass1Results, ...pass2Results, ...pass3Results];
}

Deno.serve(async (req: Request) => {
  const auth = await resolveAuth(req);
  if (auth.kind !== "user" && auth.kind !== "service") {
    return new Response("Unauthorized", { status: 401 });
  }

  const { repoUrl, projectId } = await req.json();

  const supabase = serviceRoleClient();

  // Fetch the architecture Mermaid if we have a projectId
  let mermaidContent = "";
  if (projectId) {
    const { data: project } = await supabase
      .from("projects")
      .select("readme_draft")
      .eq("id", projectId)
      .single();
    mermaidContent = (project as Record<string, unknown>)?.readme_draft as string ?? "";
  }

  // For prototype: hardcode the FatedFortress architecture.md content
  // In real use, this would be fetched from GitHub API
  const archMd = await fetch(
    "https://raw.githubusercontent.com/fatedfortress/fatedfortressv2/main/diagrams/architecture.md"
  ).then(r => r.text()).catch(() => "");

  const assets = await runScanner(supabase, repoUrl ?? "", archMd || mermaidContent);

  return Response.json({
    success: true,
    scannedAssets: assets,
    summary: {
      pass1: assets.filter(a => a.pass === 1).length,
      pass2: assets.filter(a => a.pass === 2).length,
      pass3: assets.filter(a => a.pass === 3).length,
    },
  });
});