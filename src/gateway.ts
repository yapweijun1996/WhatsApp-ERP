import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model, Provider } from '@earendil-works/pi-ai';

export type DemoGatewayConfig = {
  enabled: boolean;
  baseUrl: string;
  projectId: string;
  origin: string;
  model: string;
};

export function demoGatewayConfig(): DemoGatewayConfig {
  return {
    enabled: /^(1|true|yes)$/i.test((process.env.DEMO_GPT_ENABLED ?? 'false').trim()),
    baseUrl: (process.env.DEMO_GPT_BASE_URL ?? 'https://gpt.yapweijun1996.com').replace(/\/$/, ''),
    projectId: process.env.DEMO_GPT_PROJECT_ID ?? 'whatsapp-erp-order-intelligence',
    origin: process.env.DEMO_GPT_ORIGIN ?? 'http://127.0.0.1:32111',
    model: process.env.DEMO_GPT_MODEL?.trim() || 'demo-fast',
  };
}

export class DemoGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'DemoGatewayError';
  }
}

const DEMO_SENSITIVE_TEXT = /(?:dmo_[A-Za-z0-9._:-]+|(?:^|[^A-Za-z0-9])sk[-_][A-Za-z0-9._:-]+)/i;

function containsSensitiveDemoText(value: string): boolean { return DEMO_SENSITIVE_TEXT.test(value); }

export function demoError(status: number): string {
  if (status === 401) return 'DEMO_GPT_SESSION_UNAUTHORIZED';
  if (status === 403) return 'DEMO_GPT_ORIGIN_UNREGISTERED';
  if (status === 429) return 'DEMO_GPT_QUOTA_EXCEEDED';
  if (status === 503) return 'DEMO_GPT_DISABLED';
  return `DEMO_GPT_${status}`;
}

export type DemoTextResult = {
  text: string;
  responseId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

/** Browser Demo session/token client. dmo tokens are memory-only and never persisted. */
export class DemoGatewaySession {
  // ECMAScript private slots keep credentials out of enumerable object state,
  // JSON serialization, and the usual structured logger projections.
  #token?: string;
  #expiresAt = 0;
  #refreshPromise?: Promise<string>;

  constructor(
    private readonly config = demoGatewayConfig(),
    private readonly request: typeof fetch = fetch,
  ) {}

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.#token && Date.now() < this.#expiresAt) return this.#token;
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.openSession().finally(() => {
        this.#refreshPromise = undefined;
      });
    }
    return this.#refreshPromise;
  }

  invalidate(): void {
    this.#token = undefined;
    this.#expiresAt = 0;
  }

  /** Authenticated Demo fetch with one bounded session refresh on 401. */
  async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      try {
        headers.set('Origin', this.config.origin);
        headers.set('Authorization', `Bearer ${token}`);
        return await this.request(input, { ...init, headers });
      } catch {
        throw new DemoGatewayError(502, init.signal?.aborted ? 'DEMO_GPT_ABORTED' : 'DEMO_GPT_NETWORK_ERROR');
      }
    };

    let response = await send(await this.getToken());
    if (response.status === 401) {
      this.invalidate();
      response = await send(await this.getToken(true));
    }
    if (!response.ok) throw new DemoGatewayError(response.status, demoError(response.status));
    return response;
  }

  /** Exact restricted /demo/v1/responses contract: model + text input only. */
  async completeText(input: string, signal?: AbortSignal): Promise<DemoTextResult> {
    const response = await this.fetch(`${this.config.baseUrl}/demo/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, input }),
      signal,
    });
    return this.#parseCompletion(response);
  }

  /** Single-turn call with a system instruction. Uses the Responses API `instructions`
   * field for bounded system context. No ERP tools, no customer scope. */
  async completeWithSystem(systemInstruction: string, userMessage: string, signal?: AbortSignal): Promise<DemoTextResult> {
    const response = await this.fetch(`${this.config.baseUrl}/demo/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, instructions: systemInstruction, input: userMessage }),
      signal,
    });
    return this.#parseCompletion(response);
  }

  async #parseCompletion(response: Response): Promise<DemoTextResult> {
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new DemoGatewayError(502, 'DEMO_GPT_INVALID_RESPONSE');
    }
    const text = Array.isArray(body?.output)
      ? body.output
          .filter((item: any) => item?.type === 'message')
          .flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
          .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join('')
      : '';
    if (!text) throw new DemoGatewayError(502, 'DEMO_GPT_EMPTY_RESPONSE');
    if (containsSensitiveDemoText(text)) throw new DemoGatewayError(502, 'DEMO_GPT_RESPONSE_REDACTED');
    const usage = body?.usage && typeof body.usage === 'object'
      ? {
          inputTokens: Number(body.usage.input_tokens ?? 0),
          outputTokens: Number(body.usage.output_tokens ?? 0),
          totalTokens: Number(body.usage.total_tokens ?? 0),
        }
      : undefined;
    return {
      text,
      responseId: typeof body?.id === 'string' && !containsSensitiveDemoText(body.id) ? body.id : undefined,
      usage,
    };
  }

  private async openSession(): Promise<string> {
    let response: Response;
    try {
      response = await this.request(`${this.config.baseUrl}/demo/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: this.config.origin,
        },
        body: JSON.stringify({ project_id: this.config.projectId }),
      });
    } catch {
      throw new DemoGatewayError(502, 'DEMO_GPT_SESSION_NETWORK_ERROR');
    }
    if (!response.ok) throw new DemoGatewayError(response.status, demoError(response.status));
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new DemoGatewayError(502, 'DEMO_GPT_INVALID_SESSION');
    }
    const token = body.dmo_token ?? body.token ?? body.access_token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token)) {
      throw new DemoGatewayError(502, 'DEMO_GPT_INVALID_SESSION');
    }

    this.#token = token;
    // Documented sessions last 15 minutes. Refresh no later than 14 minutes even if a longer TTL is returned.
    const ttlSeconds = Number(body.expires_in ?? 10 * 60);
    const safeTtlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Math.min(ttlSeconds * 1000, 14 * 60 * 1000)
      : 10 * 60 * 1000;
    this.#expiresAt = Date.now() + safeTtlMs;
    return token;
  }
}

export function demoGatewayModel(config = demoGatewayConfig()): Model<'openai-responses'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-responses',
    provider: 'demo-gpt',
    baseUrl: `${config.baseUrl}/demo/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 1024,
  };
}

// Legacy trusted/private Gateway support is retained for server-side/offline compatibility.
export type GatewayMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
export type GatewayResponse = { text: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> };
export interface GptGatewayTransport {
  complete(input: { model: string; messages: GatewayMessage[]; tools?: unknown[] }): Promise<GatewayResponse>;
}

export function gatewayConfig() {
  return {
    baseUrl: process.env.GPT_GATEWAY_BASE_URL ?? process.env.GPT_GATEWAY_URL ?? 'http://127.0.0.1:8787/v1',
    apiKey: process.env.GPT_GATEWAY_API_KEY ?? '',
    model: process.env.GPT_GATEWAY_MODEL ?? 'configured-model',
  };
}

export function createGatewayProvider(): Provider<'openai-completions'> {
  const c = gatewayConfig();
  const model = {
    id: c.model,
    name: c.model,
    api: 'openai-completions' as const,
    provider: 'gpt-gateway',
    baseUrl: c.baseUrl,
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  return createProvider({
    id: 'gpt-gateway',
    name: 'GPT Gateway',
    baseUrl: c.baseUrl,
    auth: { apiKey: { name: 'GPT_GATEWAY_API_KEY', resolve: async () => ({ auth: { apiKey: c.apiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  });
}

export class OpenAICompatibleGateway implements GptGatewayTransport {
  constructor(
    private readonly endpoint = /\/chat\/completions\/?$/.test(gatewayConfig().baseUrl)
      ? gatewayConfig().baseUrl
      : `${gatewayConfig().baseUrl.replace(/\/$/, '')}/chat/completions`,
    private readonly apiKey = gatewayConfig().apiKey,
    private readonly defaultModel = gatewayConfig().model,
  ) {}

  async complete(input: { model: string; messages: GatewayMessage[]; tools?: unknown[] }): Promise<GatewayResponse> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: input.model || this.defaultModel, messages: input.messages, tools: input.tools }),
    });
    if (!response.ok) throw new Error(`GPT_GATEWAY_${response.status}`);
    const body = await response.json() as any;
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('GPT_GATEWAY_EMPTY');
    return {
      text: message.content ?? '',
      toolCalls: message.tool_calls?.map((call: any) => ({
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      })),
    };
  }
}

export class ScriptedGateway implements GptGatewayTransport {
  constructor(private readonly script: GatewayResponse[] = []) {}
  async complete(): Promise<GatewayResponse> {
    return this.script.shift() ?? { text: '' };
  }
}
