import { CATALOG, canonicalModel, openRouterId } from '../cost/catalog.js';
import { Deadline } from '../util/abort.js';
import type { ProviderConfig } from '../provider/factory.js';

/**
 * Ask every credentialed vendor which models it actually serves, and compare
 * that against the catalog.
 *
 * The catalog is a hand-maintained table of model IDs and prices, and it rots
 * silently: a model can be retired, shut down, or superseded without anything
 * in the build noticing. Over one sitting this table accumulated seven entries
 * that were already dead and three vendors that were a full generation behind,
 * and every one of them had to be found by hand.
 *
 * A missing model is the failure worth failing on. resolveTier ranks by price,
 * so a cheap dead model wins its tier outright and every delegation routed to
 * it fails. Being merely behind is reported rather than enforced, because
 * "newer exists" is a judgement call and "this cannot be called" is not.
 */

export type VendorStatus =
  /** Every catalog model for this vendor is still served. */
  | 'ok'
  /** The vendor no longer lists at least one catalog model. */
  | 'stale'
  /** No credentials, so nothing was asked. */
  | 'skipped'
  /** The vendor could not be asked: no models endpoint, an error, or an unexpected shape. */
  | 'unreachable';

export interface VendorReport {
  vendor: string;
  status: VendorStatus;
  /** Why a vendor is skipped or unreachable. */
  detail?: string;
  /** Catalog models the vendor confirms it still serves. */
  confirmed: string[];
  /** Catalog models the vendor no longer lists. This is the failure. */
  missing: string[];
  /** Models the vendor serves that the catalog does not carry. Informational. */
  uncatalogued: string[];
}

export interface VerifyResult {
  reports: VendorReport[];
  /** False when any vendor is stale. Drives the exit code. */
  ok: boolean;
  /** True when at least one vendor could not be asked, so `ok` is not a full pass. */
  incomplete: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PAGES = 20;

/**
 * Google returns `models/gemini-3.6-flash` where its own OpenAI-compatible
 * layer takes the bare ID, and Anthropic accepts both a dated ID and an
 * undated alias. Compare on one canonical spelling so neither difference
 * reads as a missing model.
 */
function normalizeId(id: string): string {
  return canonicalModel(id.replace(/^models\//, ''));
}

function endpointFor(config: ProviderConfig): { url: string; headers: Record<string, string> } {
  if (config.type === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  const base = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${config.apiKey}` } };
}

/** Every model ID the vendor reports, following pagination where offered. */
async function listVendorModels(config: ProviderConfig, signal: AbortSignal): Promise<string[]> {
  const { url, headers } = endpointFor(config);
  const ids: string[] = [];
  let next: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const target = new URL(url);
    target.searchParams.set('limit', '100');
    if (next) target.searchParams.set('after_id', next);

    const res = await fetch(target.toString(), { headers, signal, redirect: 'error' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'} from ${url}`);

    const body: any = await res.json();
    if (!Array.isArray(body?.data)) throw new Error(`unexpected response shape from ${url}`);

    for (const entry of body.data) {
      if (typeof entry?.id === 'string') ids.push(entry.id);
    }

    // Anthropic paginates with has_more/last_id; the OpenAI-compatible vendors
    // return everything at once and simply lack these fields.
    if (!body.has_more || typeof body.last_id !== 'string') break;
    next = body.last_id;
  }

  return ids;
}

function catalogModelsFor(vendor: string): string[] {
  return Object.entries(CATALOG)
    .filter(([, spec]) => spec.vendor === vendor)
    .map(([model]) => model);
}

/** One model list per endpoint per run: on a gateway all six seats share one. */
type ListCache = Map<string, Promise<string[]>>;

function listOnce(config: ProviderConfig, signal: AbortSignal, cache: ListCache): Promise<string[]> {
  const { url } = endpointFor(config);
  let pending = cache.get(url);
  if (!pending) {
    pending = listVendorModels(config, signal);
    cache.set(url, pending);
  }
  return pending;
}

/**
 * On OpenRouter the question is different: not "does the vendor still serve
 * this ID" but "does OpenRouter serve it under the ID we would send". The
 * catalog's OpenRouter IDs are mostly derived by convention (openRouterId), so
 * this is the check that proves them. A missing entry here is reported with
 * the ID that was looked for, and BOARDROOM_OPENROUTER_IDS corrects it.
 */
function checkOpenRouter(vendor: string, expected: string[], served: string[]): VendorReport {
  const offered = new Set(served);
  const idOf = (m: string) => openRouterId(m) ?? m;
  const confirmed = expected.filter(m => offered.has(idOf(m)));
  const missing = expected.filter(m => !offered.has(idOf(m))).map(m => `${m} (looked for ${idOf(m)})`);
  const carried = new Set(expected.map(idOf));
  const namespaces = new Set(expected.map(m => idOf(m).split('/')[0]));
  const uncatalogued = [...offered]
    .filter(id => namespaces.has(id.split('/')[0]) && !carried.has(id))
    .sort();
  return { vendor, status: missing.length > 0 ? 'stale' : 'ok', confirmed, missing, uncatalogued };
}

async function checkVendor(config: ProviderConfig, signal: AbortSignal, cache: ListCache): Promise<VendorReport> {
  const vendor = config.name;
  const expected = catalogModelsFor(vendor);
  const base: VendorReport = { vendor, status: 'ok', confirmed: [], missing: [], uncatalogued: [] };

  let served: string[];
  try {
    served = await listOnce(config, signal, cache);
  } catch (e: any) {
    // A vendor we cannot ask is not evidence that the catalog is wrong, so this
    // is reported rather than failed. It does mean the pass was not complete.
    return { ...base, status: 'unreachable', detail: e?.message || String(e) };
  }

  if (config.backend === 'openrouter') return checkOpenRouter(vendor, expected, served);

  const offered = new Set(served.map(normalizeId));
  const confirmed = expected.filter(m => offered.has(normalizeId(m)));
  const missing = expected.filter(m => !offered.has(normalizeId(m)));
  const carried = new Set(expected.map(normalizeId));
  const uncatalogued = [...new Set(served.map(normalizeId))].filter(m => !carried.has(m)).sort();

  return {
    vendor,
    status: missing.length > 0 ? 'stale' : 'ok',
    confirmed,
    missing,
    uncatalogued,
  };
}

export async function verifyCatalog(
  configs: ProviderConfig[],
  opts: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const credentialed = new Map(configs.map(c => [c.name, c]));
  const vendors = [...new Set(Object.values(CATALOG).map(s => s.vendor))].sort();

  const skipped = (vendor: string, detail: string): VendorReport => ({
    vendor, status: 'skipped', detail, confirmed: [], missing: [], uncatalogued: [],
  });

  // A local backend serves none of the catalog's cloud models, by design.
  // Comparing the two would call every entry stale and fail the run.
  if (configs.some(c => c.backend === 'ollama')) {
    return {
      reports: vendors.map(v => skipped(v, 'local backend: the catalog does not apply')),
      ok: true,
      incomplete: true,
    };
  }

  const deadline = new Deadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'verify-catalog');
  const cache: ListCache = new Map();
  try {
    const reports = await Promise.all(
      vendors.map(async (vendor): Promise<VendorReport> => {
        const config = credentialed.get(vendor);
        if (!config) return skipped(vendor, 'no credentials');
        return checkVendor(config, deadline.signal, cache);
      }),
    );

    return {
      reports,
      ok: reports.every(r => r.status !== 'stale'),
      incomplete: reports.some(r => r.status === 'unreachable' || r.status === 'skipped'),
    };
  } finally {
    deadline.dispose();
  }
}
