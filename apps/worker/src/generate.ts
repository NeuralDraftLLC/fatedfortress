import { FFError, hashOutput } from "@fatedfortress/protocol";
import { hasKey, getRawKey, type ProviderId } from "./keystore.js";
import type { InboundMessage, OutboundMessage } from "./router.js";

const activeGenerations = new Map<string, AbortController>();

export function abortAllGenerations(): void {
  for (const controller of activeGenerations.values()) {
    controller.abort();
  }
  activeGenerations.clear();
}

export async function handleGenerate(
  msg: Extract<InboundMessage, { type: "GENERATE" }>,
  requestId: string,
  send: (msg: OutboundMessage) => void
): Promise<void> {
  if (activeGenerations.has(requestId)) {
    throw new FFError("DuplicateRequest", "A request with this ID is already in progress");
  }

  if (!hasKey(msg.provider as ProviderId)) {
    throw new FFError("NoKeyStored", `No key stored for provider: ${msg.provider}`);
  }

  const controller = new AbortController();
  activeGenerations.set(requestId, controller);

  try {
    const adapterModule = await import(
      /* @vite-ignore */ `./adapters/${msg.provider}.js`
    );
    const adapter = adapterModule.default ?? adapterModule;
    const key = getRawKey(msg.provider as ProviderId);

    const stream: AsyncIterable<string> = adapter.generate({
      key,
      model: msg.model,
      prompt: msg.prompt,
      systemPrompt: msg.systemPrompt,
      signal: controller.signal,
    });

    let fullOutput = "";

    for await (const chunk of stream) {
      if (controller.signal.aborted) break;
      fullOutput += chunk;
      send({ type: "CHUNK", requestId, chunk });
    }

    if (!controller.signal.aborted) {
      const outputHash = await hashOutput(fullOutput);
      send({ type: "DONE", requestId, outputHash });
    }
  } finally {
    activeGenerations.delete(requestId);
  }
}
