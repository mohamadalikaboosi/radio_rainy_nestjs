import { SettingsService } from '../../administration/application/settings.service';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('LLM is not configured or disabled (Settings → Language model)');
    this.name = 'LlmNotConfiguredError';
  }
}

export interface LlmClient {
  chat(messages: LlmMessage[], signal?: AbortSignal): Promise<string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Any OpenAI-compatible chat endpoint (Ollama, LM Studio, vLLM, OpenAI...). Settings are read on every call. */
export class OpenAiCompatibleLlm implements LlmClient {
  constructor(
    private readonly settings: Pick<SettingsService, 'llm'>,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
    private readonly timeoutMs = 90_000,
  ) {}

  async chat(messages: LlmMessage[], signal?: AbortSignal): Promise<string> {
    const cfg = await this.settings.llm();
    if (!cfg) throw new LlmNotConfiguredError();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchFn(`${cfg.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model || undefined, messages, temperature: 0 }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM returned no message content');
    return content;
  }
}
