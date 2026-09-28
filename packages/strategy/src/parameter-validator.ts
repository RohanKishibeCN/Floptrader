/**
 * Strategy parameters, their bounds, and the only door model output can come
 * through.
 *
 * Every parameter is a number in a bounded range that this file owns. DeepSeek
 * may propose values; it may not propose keys, may not exceed a bound, and may
 * not touch a risk cap — the caps live in `@flop/close-call`'s risk module and
 * are not parameters at all.
 *
 * The pipeline for a model proposal is exactly:
 *   Zod shape → numeric bounds → contest rules → local simulator → official fold
 *   cross-check → parameter version audit
 * The first three happen here; the last three happen in `llm.ts` before a
 * proposal is allowed to become effective.
 */
import { z } from 'zod';
import { Decimal, StrategyGroupName, STRATEGY_GROUP_NAMES } from './types.js';

export interface NumericBound {
  min: number;
  max: number;
  step: number;
  /** What the parameter does, in one line, for the audit log. */
  about: string;
}

/**
 * Bounds per group. Deliberately narrow: a parameter swing from 0.001 to 20 is
 * not a tuning change, it is a different strategy, and this program is not
 * allowed to become one on the strength of a language model's opinion.
 */
export const PARAM_BOUNDS: Record<StrategyGroupName, Record<string, NumericBound>> = {
  trend_following: {
    slopeThreshold: { min: 0.0005, max: 0.01, step: 0.0005, about: 'minimum |slope| per sweep, as a fraction of price' },
    fastWindow: { min: 4, max: 10, step: 1, about: 'fast reference-price window' },
    slowWindow: { min: 10, max: 24, step: 1, about: 'slow reference-price window' },
    volatilityCap: { min: 0.002, max: 0.05, step: 0.001, about: 'volatility above which size is reduced' },
    sizeFraction: { min: 0.1, max: 1, step: 0.05, about: 'fraction of max_qty to offer' },
  },
  mean_reversion: {
    emaWindow: { min: 4, max: 20, step: 1, about: 'EMA window over reference prices' },
    deviationThreshold: { min: 0.003, max: 0.04, step: 0.001, about: 'deviation from EMA that triggers a fade' },
    volatilityCap: { min: 0.002, max: 0.05, step: 0.001, about: 'volatility above which the group stands down' },
    edgeBuffer: { min: 0.002, max: 0.03, step: 0.001, about: 'distance from the limit edge at which we stand down' },
    sizeFraction: { min: 0.1, max: 1, step: 0.05, about: 'fraction of max_qty to offer' },
  },
  breakout: {
    window: { min: 8, max: 24, step: 4, about: 'range lookback in sweeps' },
    breakBuffer: { min: 0.0005, max: 0.01, step: 0.0005, about: 'clearance beyond the range needed to confirm' },
    cooldownSweeps: { min: 1, max: 12, step: 1, about: 'sweeps to wait after a settled breakout' },
    maxChase: { min: 0.002, max: 0.02, step: 0.001, about: 'largest distance from the range edge we will chase' },
    sizeFraction: { min: 0.1, max: 1, step: 0.05, about: 'fraction of max_qty to offer' },
  },
  contrarian: {
    moveThreshold: { min: 0.005, max: 0.05, step: 0.001, about: 'single-sweep move that counts as over-moved' },
    trendCutoff: { min: 0.001, max: 0.01, step: 0.0005, about: 'trend strength above which the fade is disabled' },
    sizeFraction: { min: 0.05, max: 0.5, step: 0.05, about: 'fraction of max_qty to offer; this group is the smallest' },
    maxEntriesPerWindow: { min: 1, max: 3, step: 1, about: 'entries allowed inside one lookback window' },
  },
  external_offer_taker: {
    maxSpreadFromReference: { min: 0.0005, max: 0.02, step: 0.0005, about: 'largest edge we require from the reference' },
    minQty: { min: 0.1, max: 2, step: 0.1, about: 'smallest offer worth taking' },
    maxQty: { min: 0.5, max: 10, step: 0.5, about: 'largest offer we will take' },
    maxOpenNotionalFraction: { min: 0.1, max: 1, step: 0.05, about: 'share of max_open_notional one acceptance may use' },
  },
};

export type ParamValues = Record<string, number>;

export interface StrategyParams {
  group: StrategyGroupName;
  version: string;
  source: 'default' | 'deepseek' | 'operator';
  values: ParamValues;
  note?: string;
}

const NumericParamsSchema = z.record(z.string(), z.number().finite());

const ProposalSchema = z.object({
  group: z.string().optional(),
  values: NumericParamsSchema,
  note: z.string().max(280).optional(),
});

/** The parameter set each group starts from. Every value is inside its bounds. */
export const DEFAULT_PARAMS: Record<StrategyGroupName, StrategyParams> = {
  trend_following: params('trend_following', 'trend-v1', {
    slopeThreshold: 0.0015,
    fastWindow: 6,
    slowWindow: 12,
    volatilityCap: 0.012,
    sizeFraction: 0.6,
  }),
  mean_reversion: params('mean_reversion', 'meanrev-v1', {
    emaWindow: 8,
    deviationThreshold: 0.012,
    volatilityCap: 0.015,
    edgeBuffer: 0.008,
    sizeFraction: 0.5,
  }),
  breakout: params('breakout', 'breakout-v1', {
    window: 12,
    breakBuffer: 0.002,
    cooldownSweeps: 4,
    maxChase: 0.006,
    sizeFraction: 0.5,
  }),
  contrarian: params('contrarian', 'contrarian-v1', {
    moveThreshold: 0.015,
    trendCutoff: 0.004,
    sizeFraction: 0.25,
    maxEntriesPerWindow: 1,
  }),
  external_offer_taker: params('external_offer_taker', 'taker-v1', {
    maxSpreadFromReference: 0.004,
    minQty: 0.1,
    maxQty: 3,
    maxOpenNotionalFraction: 0.4,
  }),
};

function params(group: StrategyGroupName, version: string, values: ParamValues): StrategyParams {
  return { group, version, source: 'default', values };
}

export interface ValidationOutcome {
  ok: boolean;
  params?: StrategyParams;
  errors: string[];
  /** Values the model proposed that were pulled back inside a bound. */
  clamped: string[];
}

/**
 * Validate a full parameter set for a group.
 *
 * Missing parameters keep their default: a model that mentions three of five
 * knobs is proposing a change to three knobs, not deleting the other two.
 * Unknown parameters are an error, not a silent drop — a hallucinated key is a
 * signal the response is not trustworthy.
 */
export function validateParams(raw: unknown, group: StrategyGroupName): ValidationOutcome {
  const errors: string[] = [];
  const clamped: string[] = [];
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      clamped,
    };
  }
  const bounds = PARAM_BOUNDS[group];
  const base = DEFAULT_PARAMS[group];
  const values: ParamValues = { ...base.values };

  for (const [key, value] of Object.entries(parsed.data.values)) {
    const bound = bounds[key];
    if (!bound) {
      errors.push(`unknown parameter for ${group}: ${key}`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      const inside = Math.min(bound.max, Math.max(bound.min, value));
      values[key] = inside;
      clamped.push(`${key}: ${value} -> ${inside}`);
      continue;
    }
    values[key] = value;
  }
  if (errors.length > 0) return { ok: false, errors, clamped };

  // Integer parameters must be integral: a window of 6.5 sweeps is meaningless.
  for (const [key, value] of Object.entries(values)) {
    const bound = bounds[key]!;
    if (bound.step === 1 && !Number.isInteger(value)) {
      values[key] = Math.round(value);
      clamped.push(`${key}: ${value} -> ${values[key]}`);
    }
  }
  return { ok: true, params: { group, version: `${group}-auto`, source: 'deepseek', values }, errors, clamped };
}

/**
 * Turn a model proposal into an audited parameter version, or explain why not.
 * The version string carries the day so the audit trail reads as a sequence.
 */
export function proposeParams(
  group: StrategyGroupName,
  rawFromModel: unknown,
  meta: { day: string; source: StrategyParams['source'] },
): ValidationOutcome {
  const outcome = validateParams(rawFromModel, group);
  if (!outcome.ok || !outcome.params) return outcome;
  return {
    ok: true,
    errors: [],
    clamped: outcome.clamped,
    params: {
      ...outcome.params,
      source: meta.source,
      version: `${group}-${meta.day}`,
      note: (rawFromModel as { note?: string })?.note,
    },
  };
}

/** A stable digest of the values, for the parameter-version audit trail. */
export function paramsDigest(params: StrategyParams): string {
  const keys = Object.keys(params.values).sort();
  const parts = keys.map((key) => `${key}=${params.values[key]}`);
  return `${params.group}:${params.version}:${parts.join(',')}`;
}

/** The ranges, as data, for the report and the audit log. */
export function boundsSummary(group: StrategyGroupName): string[] {
  return Object.entries(PARAM_BOUNDS[group]).map(
    ([key, bound]) => `${key} in [${bound.min}, ${bound.max}] step ${bound.step}`,
  );
}

/** A parameter set that ignores the model: used whenever a proposal is refused. */
export function fallbackParams(group: StrategyGroupName): StrategyParams {
  return { ...DEFAULT_PARAMS[group], values: { ...DEFAULT_PARAMS[group].values } };
}

export function groupNames(): readonly StrategyGroupName[] {
  return STRATEGY_GROUP_NAMES;
}

export function asDecimals(values: ParamValues): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const [key, value] of Object.entries(values)) out[key] = Decimal.from(String(value));
  return out;
}
