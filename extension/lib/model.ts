// One OpenAI-compatible chat call, shared by the judge and the reflect pass.
// Global fetch only, so lib/ stays free of node built-ins. Loopback by
// default (omp's Envoy AI Gateway proxy), so no credential handling belongs
// here.

export type ChatResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

export interface ChatPort {
  complete(prompt: string, maxTokens: number): Promise<ChatResult>;
}

export function openAiChat(options: { baseUrl: string; model: string; timeoutMs: number }): ChatPort {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async complete(prompt, maxTokens) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
        const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
        const content = payload?.choices?.[0]?.message?.content;
        return typeof content === "string" ? { ok: true, text: content } : { ok: false, error: "no content in reply" };
      } catch (error) {
        return { ok: false, error: `request failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The configured model, or undefined when OMP_AUTO_LOOP_JUDGE_MODEL is unset:
 * an unconfigured deployment has neither judge nor reflect pass.
 */
export function chatFromEnv(env: Record<string, string | undefined>): ChatPort | undefined {
  const model = env.OMP_AUTO_LOOP_JUDGE_MODEL;
  if (!model) return undefined;
  return openAiChat({
    model,
    baseUrl: env.OMP_AUTO_LOOP_JUDGE_BASE_URL ?? "http://127.0.0.1:22000/v1",
    timeoutMs: Number(env.OMP_AUTO_LOOP_JUDGE_TIMEOUT_MS ?? 30_000),
  });
}
