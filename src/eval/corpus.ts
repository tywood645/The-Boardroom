// The eval corpus: 30 hand-written, closed-form business decisions.
//
// These are written by hand on purpose. A generator that produces eval
// questions is a framework for building evals, and a framework for building
// evals is not a measurement. Thirty hand-written questions beat a generator.
//
// Every question is a forced binary. Each option carries an alias list used by
// the deterministic extractor in extract.ts. Two rules govern the aliases, and
// breaking either one silently corrupts the measurement:
//
//   1. No alias of one option may appear as a substring of an alias of the
//      other option in the same question. ("raise" would match "delay the
//      raise", so bare single words that recur in the opposing phrasing are
//      avoided in favour of multi-word aliases.)
//   2. Aliases must be phrases an advisor would plausibly write in a first
//      sentence. An alias nobody says produces an unparsed vote, not a wrong
//      one, but it still costs coverage.
//
// corpus.test.ts enforces rule 1 mechanically.

export type Category = 'capital' | 'hiring' | 'product' | 'gtm';

export interface EvalOption {
  id: string;
  /** Short label shown to the panel in the forced-choice instruction. */
  label: string;
  /** Lowercase phrases matched against the advisor's first sentence. */
  aliases: string[];
}

export interface EvalQuestion {
  id: string;
  category: Category;
  prompt: string;
  options: [EvalOption, EvalOption];
}

export const CORPUS: EvalQuestion[] = [
  // ----- capital -----
  {
    id: 'cap-01',
    category: 'capital',
    prompt: 'We have 9 months of runway and flat revenue. Do we raise a seed round now, or extend runway by cutting burn?',
    options: [
      { id: 'raise', label: 'raise now', aliases: ['raise now', 'raise the round', 'raise a seed', 'start the raise', 'go out and raise'] },
      { id: 'extend', label: 'extend runway', aliases: ['extend runway', 'extend the runway', 'cut burn', 'cut the burn', 'lengthen runway'] },
    ],
  },
  {
    id: 'cap-02',
    category: 'capital',
    prompt: 'Two term sheets: a strategic investor at a 40% higher valuation with commercial strings, or a financial VC at a lower valuation with clean terms. Which do we take?',
    options: [
      { id: 'strategic', label: 'strategic investor', aliases: ['strategic investor', 'the strategic', 'strategic money', 'strategic term sheet'] },
      { id: 'financial', label: 'financial VC', aliases: ['financial vc', 'the financial investor', 'clean terms', 'financial term sheet'] },
    ],
  },
  {
    id: 'cap-03',
    category: 'capital',
    prompt: 'We are raising $1.5M. Do we structure it as a convertible note, or as a priced round?',
    options: [
      { id: 'note', label: 'convertible note', aliases: ['convertible note', 'the note', 'safe note', 'a safe'] },
      { id: 'priced', label: 'priced round', aliases: ['priced round', 'price the round', 'priced equity'] },
    ],
  },
  {
    id: 'cap-04',
    category: 'capital',
    prompt: 'Burn is 30% above plan. Do we cut spend by 20% immediately, or hold spend and raise a bridge from existing investors?',
    options: [
      { id: 'cut', label: 'cut spend', aliases: ['cut spend', 'cut the spend', 'cut costs', 'reduce burn', 'cut 20'] },
      { id: 'bridge', label: 'bridge round', aliases: ['bridge round', 'raise a bridge', 'the bridge', 'bridge from'] },
    ],
  },
  {
    id: 'cap-05',
    category: 'capital',
    prompt: 'We have $40k MRR and need capital. Do we take revenue-based financing, or sell equity?',
    options: [
      { id: 'rbf', label: 'revenue-based financing', aliases: ['revenue-based financing', 'revenue based financing', 'rbf', 'non-dilutive'] },
      { id: 'equity', label: 'equity round', aliases: ['equity round', 'sell equity', 'dilutive equity', 'raise equity'] },
    ],
  },
  {
    id: 'cap-06',
    category: 'capital',
    prompt: 'The founder is paying themselves $0. Do we move them to a market salary, or keep them below market to extend runway?',
    options: [
      { id: 'market', label: 'market salary', aliases: ['market salary', 'pay market', 'full salary', 'market rate'] },
      { id: 'below', label: 'below market', aliases: ['below market', 'stay unpaid', 'keep the salary low', 'defer salary'] },
    ],
  },
  {
    id: 'cap-07',
    category: 'capital',
    prompt: 'We have $200k of discretionary budget left this year. Do we spend it on sales headcount, or on product engineering?',
    options: [
      { id: 'sales', label: 'sales headcount', aliases: ['sales headcount', 'spend it on sales', 'hire sales', 'sales hire'] },
      { id: 'engineering', label: 'product engineering', aliases: ['product engineering', 'spend it on product', 'engineering headcount', 'hire engineers'] },
    ],
  },
  {
    id: 'cap-08',
    category: 'capital',
    prompt: 'An acquirer offers a modest acquihire that clears our investors but returns little to the founder. Do we accept the acquihire, or stay independent for another 18 months?',
    options: [
      { id: 'accept', label: 'accept the acquihire', aliases: ['accept the acquihire', 'take the acquihire', 'take the offer', 'accept the offer', 'sell now'] },
      { id: 'independent', label: 'stay independent', aliases: ['stay independent', 'remain independent', 'keep building', 'turn it down', 'reject the offer'] },
    ],
  },

  // ----- hiring -----
  {
    id: 'hir-01',
    category: 'hiring',
    prompt: 'We closed 11 deals last year, all founder-led. Do we hire a VP Sales, or build an inside sales team?',
    options: [
      { id: 'vp', label: 'VP Sales', aliases: ['vp sales', 'vp of sales', 'hire the vp', 'sales leader'] },
      { id: 'inside', label: 'inside sales', aliases: ['inside sales', 'build inside', 'sdr team', 'junior reps'] },
    ],
  },
  {
    id: 'hir-02',
    category: 'hiring',
    prompt: 'We have budget for one senior engineer or two junior engineers. Which do we hire?',
    options: [
      { id: 'senior', label: 'senior engineer', aliases: ['senior engineer', 'one senior', 'the senior', 'senior hire'] },
      { id: 'juniors', label: 'two juniors', aliases: ['two juniors', 'two junior', 'the juniors', 'junior engineers'] },
    ],
  },
  {
    id: 'hir-03',
    category: 'hiring',
    prompt: 'We need a data engineer for a 6-month project with unclear follow-on work. Do we bring in a contractor, or make a full-time hire?',
    options: [
      { id: 'contractor', label: 'contractor', aliases: ['contractor', 'contract hire', 'fractional', 'agency'] },
      { id: 'fulltime', label: 'full-time hire', aliases: ['full-time hire', 'full time hire', 'permanent hire', 'hire full-time', 'hire full time'] },
    ],
  },
  {
    id: 'hir-04',
    category: 'hiring',
    prompt: 'Our product looks dated and it is costing us deals. Do we hire an in-house designer, or outsource design to a studio?',
    options: [
      { id: 'inhouse', label: 'in-house designer', aliases: ['in-house designer', 'in house designer', 'hire a designer', 'full-time designer'] },
      { id: 'outsource', label: 'outsource design', aliases: ['outsource design', 'outsource the design', 'design studio', 'use an agency'] },
    ],
  },
  {
    id: 'hir-05',
    category: 'hiring',
    prompt: 'An engineer hired 5 months ago is clearly below bar and the team has noticed. Do we terminate now, or run a 60-day performance plan?',
    options: [
      { id: 'terminate', label: 'terminate now', aliases: ['terminate now', 'let them go', 'fire them', 'terminate immediately', 'part ways'] },
      { id: 'pip', label: 'performance plan', aliases: ['performance plan', 'a pip', 'the pip', '60-day plan', '60 day plan'] },
    ],
  },
  {
    id: 'hir-06',
    category: 'hiring',
    prompt: 'The founder is non-technical and shipping is slow. Do we recruit a technical co-founder with real equity, or stay solo and hire contractors?',
    options: [
      { id: 'cofounder', label: 'technical co-founder', aliases: ['technical co-founder', 'technical cofounder', 'find a co-founder', 'bring on a co-founder'] },
      { id: 'solo', label: 'stay solo', aliases: ['stay solo', 'remain solo', 'stay sole founder', 'keep full ownership'] },
    ],
  },
  {
    id: 'hir-07',
    category: 'hiring',
    prompt: 'Support volume has tripled. Do we offshore the support team, or keep support domestic and slower to scale?',
    options: [
      { id: 'offshore', label: 'offshore support', aliases: ['offshore support', 'offshore the support', 'offshore team', 'move support offshore'] },
      { id: 'domestic', label: 'domestic support', aliases: ['domestic support', 'keep support domestic', 'keep it in-house', 'local team'] },
    ],
  },

  // ----- product -----
  {
    id: 'pro-01',
    category: 'product',
    prompt: 'Customers want a Salesforce integration. Do we build it in-house, or buy a third-party integration vendor?',
    options: [
      { id: 'build', label: 'build in-house', aliases: ['build in-house', 'build in house', 'build it ourselves', 'build our own'] },
      { id: 'buy', label: 'buy the vendor', aliases: ['buy the vendor', 'buy it', 'use a vendor', 'third-party vendor', 'license it'] },
    ],
  },
  {
    id: 'pro-02',
    category: 'product',
    prompt: 'A legacy service causes a third of our incidents. Do we rewrite it, or keep patching it and ship features instead?',
    options: [
      { id: 'rewrite', label: 'rewrite it', aliases: ['rewrite it', 'rewrite the service', 'do the rewrite', 'replace the service'] },
      { id: 'patch', label: 'keep patching', aliases: ['keep patching', 'patch it', 'continue patching', 'incremental fixes'] },
    ],
  },
  {
    id: 'pro-03',
    category: 'product',
    prompt: 'The MVP has three known non-critical bugs. Do we ship now, or delay six weeks to polish?',
    options: [
      { id: 'ship', label: 'ship now', aliases: ['ship now', 'ship it now', 'ship immediately', 'release now', 'ship this week'] },
      { id: 'delay', label: 'delay to polish', aliases: ['delay to polish', 'delay six weeks', 'delay the launch', 'hold the release', 'wait and polish'] },
    ],
  },
  {
    id: 'pro-04',
    category: 'product',
    prompt: 'One quarter of engineering capacity is free. Do we build enterprise SSO to unblock big deals, or improve onboarding to fix activation?',
    options: [
      { id: 'sso', label: 'enterprise SSO', aliases: ['enterprise sso', 'build sso', 'the sso work', 'saml support'] },
      { id: 'onboarding', label: 'improve onboarding', aliases: ['improve onboarding', 'fix onboarding', 'the onboarding work', 'activation flow'] },
    ],
  },
  {
    id: 'pro-05',
    category: 'product',
    prompt: 'Half our traffic is mobile. Do we build a native mobile app, or invest in a responsive web experience?',
    options: [
      { id: 'native', label: 'native mobile app', aliases: ['native mobile app', 'native app', 'build the app', 'ios and android'] },
      { id: 'web', label: 'responsive web', aliases: ['responsive web', 'mobile web', 'responsive site', 'web experience'] },
    ],
  },
  {
    id: 'pro-06',
    category: 'product',
    prompt: 'Our free tier is 80% of users and 4% of revenue, and it drives most support load. Do we deprecate the free tier, or keep it as a funnel?',
    options: [
      { id: 'deprecate', label: 'deprecate the free tier', aliases: ['deprecate the free tier', 'kill the free tier', 'remove the free tier', 'sunset free'] },
      { id: 'keep', label: 'keep the free tier', aliases: ['keep the free tier', 'retain the free tier', 'preserve free', 'keep it free'] },
    ],
  },
  {
    id: 'pro-07',
    category: 'product',
    prompt: 'One customer is 30% of revenue and wants a bespoke roadmap. Do we build for the whale, or build for the long tail?',
    options: [
      { id: 'whale', label: 'the whale', aliases: ['the whale', 'build for the whale', 'serve the big customer', 'bespoke roadmap'] },
      { id: 'longtail', label: 'the long tail', aliases: ['the long tail', 'build for the long tail', 'broader market', 'smaller customers'] },
    ],
  },
  {
    id: 'pro-08',
    category: 'product',
    prompt: 'A competitor just open-sourced their engine. Do we open-source our core, or keep it closed and compete on product?',
    options: [
      { id: 'open', label: 'open-source the core', aliases: ['open-source the core', 'open source the core', 'go open source', 'open our core'] },
      { id: 'closed', label: 'keep it closed', aliases: ['keep it closed', 'stay closed', 'remain proprietary', 'keep it proprietary'] },
    ],
  },

  // ----- gtm -----
  {
    id: 'gtm-01',
    category: 'gtm',
    prompt: 'We are repricing. Do we move to usage-based pricing, or stay on per-seat pricing?',
    options: [
      { id: 'usage', label: 'usage-based pricing', aliases: ['usage-based pricing', 'usage based pricing', 'consumption pricing', 'meter usage'] },
      { id: 'seat', label: 'per-seat pricing', aliases: ['per-seat pricing', 'per seat pricing', 'seat-based', 'stay per-seat'] },
    ],
  },
  {
    id: 'gtm-02',
    category: 'gtm',
    prompt: 'We win 60% of deals and nobody negotiates. Do we raise prices 30%, or hold prices and chase volume?',
    options: [
      { id: 'raise', label: 'raise prices', aliases: ['raise prices', 'raise the price', 'increase prices', 'price up'] },
      { id: 'hold', label: 'hold prices', aliases: ['hold prices', 'hold the price', 'keep prices flat', 'chase volume'] },
    ],
  },
  {
    id: 'gtm-03',
    category: 'gtm',
    prompt: 'ACV is $8k. Do we build a self-serve motion, or an outbound sales-led motion?',
    options: [
      { id: 'selfserve', label: 'self-serve', aliases: ['self-serve', 'self serve', 'product-led', 'plg motion'] },
      { id: 'outbound', label: 'outbound sales', aliases: ['outbound sales', 'sales-led', 'sales led', 'outbound motion', 'hire reps'] },
    ],
  },
  {
    id: 'gtm-04',
    category: 'gtm',
    prompt: 'We can credibly serve either segment but not both this year. Do we target SMB, or target enterprise?',
    options: [
      { id: 'smb', label: 'SMB', aliases: ['smb', 'small business', 'smaller accounts', 'the low end'] },
      { id: 'enterprise', label: 'enterprise', aliases: ['enterprise', 'large accounts', 'upmarket', 'the high end'] },
    ],
  },
  {
    id: 'gtm-05',
    category: 'gtm',
    prompt: 'We are ready to go public with the product. Do we launch on Product Hunt, or run a quiet beta with design partners?',
    options: [
      { id: 'ph', label: 'Product Hunt launch', aliases: ['product hunt', 'public launch', 'launch loudly', 'big launch'] },
      { id: 'quiet', label: 'quiet beta', aliases: ['quiet beta', 'private beta', 'design partners', 'soft launch'] },
    ],
  },
  {
    id: 'gtm-06',
    category: 'gtm',
    prompt: 'We have $10k/month for demand generation. Do we put it into paid ads, or into content and SEO?',
    options: [
      { id: 'ads', label: 'paid ads', aliases: ['paid ads', 'paid acquisition', 'run ads', 'paid search'] },
      { id: 'content', label: 'content and SEO', aliases: ['content and seo', 'content marketing', 'invest in seo', 'organic content'] },
    ],
  },
  {
    id: 'gtm-07',
    category: 'gtm',
    prompt: 'A reseller offers distribution into 200 accounts for 30% of revenue. Do we sign the channel partner, or stay direct?',
    options: [
      { id: 'channel', label: 'channel partner', aliases: ['channel partner', 'sign the reseller', 'the reseller', 'go through the channel'] },
      { id: 'direct', label: 'stay direct', aliases: ['stay direct', 'remain direct', 'sell direct', 'keep it direct'] },
    ],
  },
];

export const CATEGORIES: Category[] = ['capital', 'hiring', 'product', 'gtm'];

/**
 * The instruction appended to every eval question.
 *
 * The panel's round-1 format already requires the first sentence to be the
 * recommendation. This suffix additionally pins the vocabulary, which is what
 * lets a regex rather than a judge model read the answer.
 */
export function forcedChoiceSuffix(q: EvalQuestion): string {
  const [a, b] = q.options;
  return `\n\nYour first sentence must name exactly one of these two options, using its wording: "${a.label}" or "${b.label}". Do not name both in the first sentence.`;
}

export function selectQuestions(category?: Category, limit?: number): EvalQuestion[] {
  const pool = category ? CORPUS.filter(q => q.category === category) : CORPUS;
  return typeof limit === 'number' ? pool.slice(0, limit) : pool;
}
