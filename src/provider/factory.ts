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

function detectKeyProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({
      name: 'anthropic',
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Must be a currently active model: Sonnet 4 was retired on 2026-06-15
      // and every request to it now fails.
      model: process.env.BOARDROOM_ANTHROPIC_MODEL || 'claude-sonnet-5',
    });
  }

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: 'openai',
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    });
  }

  if (process.env.XAI_API_KEY) {
    providers.push({
      name: 'xai',
      type: 'openai',
      apiKey: process.env.XAI_API_KEY,
      model: 'grok-3',
      baseUrl: 'https://api.x.ai/v1',
    });
  }

  if (process.env.GOOGLE_API_KEY) {
    providers.push({
      name: 'google',
      type: 'openai',
      apiKey: process.env.GOOGLE_API_KEY,
      model: 'gemini-2.0-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
  }

  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({
      name: 'deepseek',
      type: 'openai',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    });
  }

  if (process.env.PERPLEXITY_API_KEY) {
    providers.push({
      name: 'perplexity',
      type: 'openai',
      apiKey: process.env.PERPLEXITY_API_KEY,
      model: 'sonar-pro',
      baseUrl: 'https://api.perplexity.ai',
    });
  }

  return providers;
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

  if (backend === 'ollama') return ollamaBoard();
  if (backend === 'openrouter') return process.env.OPENROUTER_API_KEY ? openRouterBoard() : [];
  if (backend === 'keys') return detectKeyProviders();

  // auto: explicit per-vendor keys win, then OpenRouter, then local Ollama.
  const keyed = detectKeyProviders();
  if (keyed.length > 0) return keyed;
  if (process.env.OPENROUTER_API_KEY) return openRouterBoard();
  if (process.env.OLLAMA_HOST) return ollamaBoard();
  return [];
}
