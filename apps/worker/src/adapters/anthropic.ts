interface AdapterGenerateOptions {
  key: string;
  model: string;
  prompt: string;
  systemPrompt: string;
  signal: AbortSignal;
}

export default {
  async *generate(opts: AdapterGenerateOptions): AsyncGenerator<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          ...(opts.systemPrompt
            ? [{ role: "user" as const, content: `[System] ${opts.systemPrompt}` }]
            : [{ role: "user" as const, content: "" }]),
          { role: "user", content: opts.prompt },
        ],
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${err}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "content_block_delta") {
              yield parsed.delta?.text ?? "";
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
};