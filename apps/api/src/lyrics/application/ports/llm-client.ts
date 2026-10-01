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
