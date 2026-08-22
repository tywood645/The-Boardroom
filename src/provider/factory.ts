import { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';

export interface ProviderConfig {
  name: string;
  type: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  if (config.type === 'anthropic') {
    return new AnthropicProvider(config.apiKey, config.model);
  }
  return new OpenAICompatProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    name: config.name,
  });
}

/**
 * The six board seats, one per vendor.
 *
 * Every seat's model can be overridden with BOARDROOM_<VENDOR>_MODEL, so a new
 * release never needs a code change and nobody is stuck on whatever was
 * current when this table was last edited. The defaults are a starting point,
 * not a constraint: they are simply each vendor's current generation, and the
 * override is checked first.
 *
 * Only BOARDROOM_ANTHROPIC_MODEL used to be honoured; the other five seats
 * were hardcoded, which made a stale default here impossible to work around
 * without editing source.
 */
const KEY_SEATS = [
  { name: 'anthropic', type: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5' },
  { name: 'openai', type: 'openai', keyEnv: 'OPENAI_API_KEY', model: 'gpt-5.6-terra', baseUrl: 'https://api.openai.com/v1' },
  { name: 'xai', type: 'openai', keyEnv: 'XAI_API_KEY', model: 'grok-4.5', baseUrl: 'https://api.x.ai/v1' },
  { name: 'google', type: 'openai', keyEnv: 'GOOGLE_API_KEY', model: 'gemini-3.6-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'deepseek', type: 'openai', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'perplexity', type: 'openai', keyEnv: 'PERPLEXITY_API_KEY', model: 'sonar-pro', baseUrl: 'https://api.perplexity.ai' },
] as const;

/** The env var that overrides a seat's model, e.g. BOARDROOM_GOOGLE_MODEL. */
export function seatModelEnv(vendor: string): string {
  return `BOARDROOM_${vendor.toUpperCase()}_MODEL`;
}

function detectKeyProviders(): ProviderConfig[] {
  return KEY_SEATS.flatMap((seat): ProviderConfig[] => {
    const apiKey = process.env[seat.keyEnv];
    if (!apiKey) return [];
    return [
      {
        name: seat.name,
        type: seat.type,
        apiKey,
        model: process.env[seatModelEnv(seat.name)] || seat.model,
        ...('baseUrl' in seat ? { baseUrl: seat.baseUrl } : {}),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Free and local backends
//
// Three ways to seat the board, chosen by BOARDROOM_BACKEND (default 'auto'):
//   keys        per-vendor API keys (the default when any are set)
//   openrouter  one OPENROUTER_API_KEY, every seat routed through OpenRouter
//   ollama      local models served by Ollama, no keys and no cost
// 'auto' prefers per-vendor keys, then OpenRouter, then local Ollama.
//
// The six seat names below preserve the role mapping (see roles.ts); only the
// underlying model changes. Override any seat with BOARDROOM_<BACKEND>_<SEAT>,
// for example BOARDROOM_OLLAMA_ANTHROPIC=llama3.3 or BOARDROOM_OPENROUTER_CFO...
// (seat keys are anthropic, openai, deepseek, xai, google, perplexity).
// ---------------------------------------------------------------------------

const SEATS = ['anthropic', 'openai', 'deepseek', 'xai', 'google', 'perplexity'];

const OLLAMA_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'llama3.1',
  openai: 'qwen2.5',
  deepseek: 'deepseek-r1',
  xai: 'mistral',
  google: 'gemma2',
  perplexity: 'phi3',
};

function seatModel(prefix: string, seat: string, fallback: string): string {
  return process.env[prefix + '_' + seat.toUpperCase()] || fallback;
}

function ollamaBoard(): ProviderConfig[] {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const single = process.env.BOARDROOM_OLLAMA_MODEL;
  return SEATS.map(name => ({
    name,
    type: 'openai' as const,
    apiKey: 'ollama', // Ollama ignores the key, but the client expects a value.
    model: seatModel('BOARDROOM_OLLAMA', name, single || OLLAMA_DEFAULT_MODELS[name]),
    baseUrl: host + '/v1',
  }));
}

/**
 * Seat the board from ONE OpenAI-compatible endpoint, naming a different model
 * per seat.
 *
 * This is the general form of "any model can be any board member". The other
 * backends tie a seat to a vendor: the anthropic seat calls Anthropic, the xai
 * seat calls xAI. Here a seat is just a name with a model string attached, so a
 * board can mix vendors freely, or seat six models from one vendor, or put
 * Claude in the CFO chair and Grok in the CEO chair, without touching roles.ts.
 *
 * Any gateway that speaks the OpenAI chat-completions API works: a local proxy,
 * a self-hosted router, LiteLLM, or a vendor endpoint. Configure with:
 *
 *   BOARDROOM_GATEWAY_URL     base URL, e.g. http://host:8080/v1
 *   BOARDROOM_GATEWAY_KEY     bearer token
 *   BOARDROOM_GATEWAY_SEATS   comma-separated seat=model pairs
 *
 * Seat names are arbitrary. They are what the report calls each panelist, and
 * they are what --compare selects, so they should be recognisable.
 */
function gatewayBoard(): ProviderConfig[] {
  const baseUrl = (process.env.BOARDROOM_GATEWAY_URL || '').replace(/\/$/, '');
  const apiKey = process.env.BOARDROOM_GATEWAY_KEY || '';
  const spec = process.env.BOARDROOM_GATEWAY_SEATS || '';
  if (!baseUrl || !spec) return [];

  const seats: ProviderConfig[] = [];
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    // Split on the FIRST '=' only: a model string may itself contain one.
    const eq = trimmed.indexOf('=');
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    const model = (eq === -1 ? trimmed : trimmed.slice(eq + 1)).trim();
    if (!name || !model) continue;
    seats.push({
      name,
      type: 'openai',
      apiKey,
      // A per-seat override still wins, so one seat can be repointed without
      // rewriting the whole seat list.
      model: process.env[seatModelEnv(name)] || model,
      baseUrl,
    });
  }
  return seats;
}

function openRouterBoard(): ProviderConfig[] {
  const key = process.env.OPENROUTER_API_KEY || '';
  const single = process.env.OPENROUTER_MODEL;
  // Default to one cheap, widely available model. Set per-seat overrides or a
  // ':free' slug (see https://openrouter.ai/models?max_price=0) to run for free.
  return SEATS.map(name => ({
    name,
    type: 'openai' as const,
    apiKey: key,
    model: seatModel('BOARDROOM_OPENROUTER', name, single || 'meta-llama/llama-3.1-8b-instruct'),
    baseUrl: 'https://openrouter.ai/api/v1',
  }));
}

export function detectProviders(): ProviderConfig[] {
  const backend = (process.env.BOARDROOM_BACKEND || 'auto').toLowerCase();

  if (backend === 'gateway') return gatewayBoard();
  if (backend === 'ollama') return ollamaBoard();
  if (backend === 'openrouter') return process.env.OPENROUTER_API_KEY ? openRouterBoard() : [];
  if (backend === 'keys') return detectKeyProviders();

  // auto: an explicit seat list wins, then per-vendor keys, then OpenRouter,
  // then local Ollama. The gateway goes first because configuring it is
  // unambiguous intent: nobody sets a seat list by accident.
  const gateway = gatewayBoard();
  if (gateway.length > 0) return gateway;
  const keyed = detectKeyProviders();
  if (keyed.length > 0) return keyed;
  if (process.env.OPENROUTER_API_KEY) return openRouterBoard();
  if (process.env.OLLAMA_HOST) return ollamaBoard();
  return [];
}
