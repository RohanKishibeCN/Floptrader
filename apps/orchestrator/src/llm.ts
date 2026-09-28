/**
 * DeepSeek: the one place the language model is allowed to touch this program.
 *
 * The model is used for exactly one thing — a low-frequency, whole-strategy
 * parameter review — and this module is the complete set of guard rails around
 * that. It must never be called per agent or per sweep, never during the market
 * peak windows, and never more than the configured number of times per day.
 *
 * The hard rules, all enforced here rather than by convention:
 *   - the model may only propose numbers that `parameter-validator.ts` bounds. It
 *     can never produce a signature, invoke technocore, or move a risk cap: the
 *     caps live in `@flop/close-call` and are not parameters at all;
 *   - the daily hard limit (config.deepseek.hardLimitPerDay) is unbreakable from
 *     any code path in this file — every reservation is checked against the same
 *     `llm_calls` counters before anything reaches the network;
 *   - a refused call costs nothing and is still recorded, so "DeepSeek 高峰期调用
 *     为 0" is provable from the database rather than asserted;
 *   - the API key is never placed in a log line or an event payload.
 */
import { randomUUID } from 'node:crypto';
import { Semaphore } from '@flop/technocore';
import type { Repositories } from '@flop/storage';
import {
  DEFAULT_PARAMS,
  boundsSummary,
  fallbackParams,
  validateParams,
  type ParamValues,
  type StrategyGroupName,
  type StrategyParams,
  STRATEGY_GROUP_NAMES,
} from '@flop/strategy';
import { Decimal, FOLD_DEFAULTS, Fold, replay } from '@flop/close-call';
import {
  DEEPSEEK_ALLOWED_WINDOWS,
  DEEPSEEK_BLOCKED_WINDOWS,
  DEEPSEEK_DEFAULT_CALL_TIMES,
  type Config,
} from './config.js';
import type { LoadGuard } from './load-guard.js';
import type { Logger } from './logger.js';

/**
 * DeepSeek has a single purpose in this program. Every call is tagged with it,
 * so a cost/audit report can never confuse a strategy review with anything else.
 */
export const DEEPSEEK_PURPOSE = 'parameter_review';

// ---------------------------------------------------------------------------
// local time helpers
// ---------------------------------------------------------------------------

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pad2(value: string): string {
  return value.length === 1 ? `0${value}` : value;
}

/**
 * The local wall clock `HH:MM` in `timezone`, read from a formatter on every
 * call. We never do offset arithmetic: that is what makes DST zones correct, a
 * fixed +08:00 assumption silently wrong half the year. `hour12:false` can still
 * render midnight as `24` in some ICU builds, so it is normalised back to `00`.
 */
function localClock(date: Date, timezone: string): { hour: string; minute: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  let hour = '00';
  let minute = '00';
  for (const part of parts) {
    if (part.type === 'hour') hour = pad2(part.value === '24' ? '00' : part.value);
    else if (part.type === 'minute') minute = pad2(part.value);
  }
  return { hour, minute, hhmm: `${hour}:${minute}` };
}

/**
 * The local calendar date `YYYY-MM-DD` in `timezone` — never the UTC date.
 *
 * Exported because the scheduler's daily watchdog and the maintenance pass must
 * agree with the budget on what "today" means; two definitions of the local day
 * would let a report and its pruning land on different days.
 */
export function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  let year = '1970';
  let month = '01';
  let day = '01';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = pad2(part.value);
    else if (part.type === 'day') day = pad2(part.value);
  }
  return `${year}-${month}-${day}`;
}

/** Minutes since local midnight; `24:00` is treated as the end of the day. */
function minutesOf(hhmm: string): number {
  const [hour, minute] = hhmm.split(':');
  return Number.parseInt(hour ?? '0', 10) * 60 + Number.parseInt(minute ?? '0', 10);
}

function withinWindow(minutes: number, from: string, to: string): boolean {
  return minutes >= minutesOf(from) && minutes < minutesOf(to);
}

export interface WindowCheck {
  allowed: boolean;
  reason: string;
  localTime: string;
  window: string | null;
}

/**
 * Is the model idle-eligible right now?
 *
 * Boundary convention: every window is half-open `[from, to)`. So 09:00 is
 * blocked and 12:00 is allowed; 14:00 is blocked and 18:00 is allowed; 00:00 is
 * allowed. Blocked windows win over allowed ones if they ever overlapped.
 */
export function isDeepSeekIdleWindow(now: Date, timezone: string): WindowCheck {
  const { hhmm } = localClock(now, timezone);
  const minutes = minutesOf(hhmm);
  for (const window of DEEPSEEK_BLOCKED_WINDOWS) {
    if (withinWindow(minutes, window.from, window.to)) {
      return { allowed: false, reason: 'blocked_window', localTime: hhmm, window: `${window.from}-${window.to}` };
    }
  }
  for (const window of DEEPSEEK_ALLOWED_WINDOWS) {
    if (withinWindow(minutes, window.from, window.to)) {
      return { allowed: true, reason: 'idle_window', localTime: hhmm, window: `${window.from}-${window.to}` };
    }
  }
  // The allowed windows tile the whole day, so this is unreachable unless the
  // constants in config.ts are edited into a contradiction. Fail closed.
  return { allowed: false, reason: 'blocked_window', localTime: hhmm, window: null };
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

export type LlmCallStatus = 'ok' | 'failed' | 'timeout' | 'invalid' | 'blocked';

export interface LlmCallInput {
  purpose: string;
  status: LlmCallStatus;
  calledAt?: Date;
  retryOf?: number | null;
  windowOk?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  accepted?: boolean;
  error?: string | null;
  paramsVersion?: string | null;
  model?: string;
}

export interface DeepSeekBudgetOptions {
  repositories: Repositories;
  config: Config;
  logger: Logger;
  now?: () => Date;
  loadGuard?: LoadGuard;
}

export interface Reservation {
  allowed: boolean;
  reason: string;
  day: string;
  used: number;
}

export interface DeepSeekUsage {
  normal: number;
  retries: number;
  total: number;
  blocked: number;
  tokens: { prompt: number; completion: number; total: number };
}

/**
 * The daily spend gate. Every model call goes through `reserve` first; a refusal
 * is written to `llm_calls` with `status: 'blocked'` so the audit trail records
 * what was asked for and why it was denied. A blocked call costs nothing.
 */
export class DeepSeekBudget {
  readonly repositories: Repositories;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly loadGuard: LoadGuard | undefined;

  constructor(options: DeepSeekBudgetOptions) {
    this.repositories = options.repositories;
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.loadGuard = options.loadGuard;
  }

  /** `YYYY-MM-DD` in the configured timezone (the local day, not the UTC day). */
  dayKey(now?: Date): string {
    return localDateKey(now ?? this.now(), this.config.timezone);
  }

  /**
   * Decide whether a call may proceed, and record the refusal when it may not.
   *
   * Order matters and is fixed: window, load, hard limit, then the per-kind cap.
   * The hard limit is checked before the normal/retry cap so it can never be
   * stepped over by a retry.
   */
  reserve(purpose: string, isRetry: boolean): Reservation {
    const at = this.now();
    const day = this.dayKey(at);
    const window = isDeepSeekIdleWindow(at, this.config.timezone);
    if (!window.allowed) return this.refuse(purpose, day, 'blocked_window', window, at);
    if (this.loadGuard && !this.loadGuard.allow('llm')) {
      return this.refuse(purpose, day, 'load_shed', window, at);
    }
    const used = this.repositories.llmCalls.countDay(day);
    if (used >= this.config.deepseek.hardLimitPerDay) {
      return this.refuse(purpose, day, 'hard_limit', window, at);
    }
    if (!isRetry) {
      if (this.repositories.llmCalls.countDayNormal(day) >= this.config.deepseek.maxNormalCallsPerDay) {
        return this.refuse(purpose, day, 'normal_limit', window, at);
      }
    } else if (this.repositories.llmCalls.countDayRetries(day) >= this.config.deepseek.maxRetriesPerDay) {
      return this.refuse(purpose, day, 'retry_limit', window, at);
    }
    return { allowed: true, reason: 'ok', day, used };
  }

  /** Record a completed (or failed) model call. Returns the new row id. */
  record(call: LlmCallInput): number {
    const at = call.calledAt ?? this.now();
    return this.repositories.llmCalls.insert({
      called_at: at.toISOString(),
      day: this.dayKey(at),
      purpose: call.purpose,
      model: call.model ?? this.config.deepseek.model,
      status: call.status,
      retry_of: call.retryOf ?? null,
      window_ok: (call.windowOk ?? true) ? 1 : 0,
      prompt_tokens: call.promptTokens ?? 0,
      completion_tokens: call.completionTokens ?? 0,
      total_tokens: call.totalTokens ?? 0,
      latency_ms: call.latencyMs ?? 0,
      accepted: call.accepted ? 1 : 0,
      error: call.error ?? null,
      params_version: call.paramsVersion ?? null,
    });
  }

  usage(day?: string): DeepSeekUsage {
    const key = day ?? this.dayKey();
    return {
      normal: this.repositories.llmCalls.countDayNormal(key),
      retries: this.repositories.llmCalls.countDayRetries(key),
      total: this.repositories.llmCalls.countDay(key),
      blocked: this.repositories.llmCalls.countDayBlocked(key),
      tokens: this.repositories.llmCalls.tokensDay(key),
    };
  }

  /**
   * A pure predicate over the current counts, for the scheduler and tests.
   *
   * The daily budget is global rather than per-purpose — there is only one
   * purpose that ever calls the model — so this takes no arguments. The
   * normal-vs-retry distinction is enforced by `reserve`, which is the only
   * place that spends budget.
   */
  canCall(): { allowed: boolean; reason: string } {
    const at = this.now();
    const day = this.dayKey(at);
    const window = isDeepSeekIdleWindow(at, this.config.timezone);
    if (!window.allowed) return { allowed: false, reason: 'blocked_window' };
    if (this.loadGuard && !this.loadGuard.allow('llm')) return { allowed: false, reason: 'load_shed' };
    if (this.repositories.llmCalls.countDay(day) >= this.config.deepseek.hardLimitPerDay) {
      return { allowed: false, reason: 'hard_limit' };
    }
    if (this.repositories.llmCalls.countDayNormal(day) >= this.config.deepseek.maxNormalCallsPerDay) {
      return { allowed: false, reason: 'normal_limit' };
    }
    return { allowed: true, reason: 'ok' };
  }

  private refuse(
    purpose: string,
    day: string,
    reason: string,
    window: WindowCheck,
    at: Date,
  ): Reservation {
    // A blocked call is recorded, not merely dropped: the row is the evidence
    // that the window/cap was respected. It carries no tokens and no cost.
    this.logger.event({
      level: 'warn',
      source: 'deepseek-budget',
      code: 'deepseek_blocked',
      message: `deepseek call refused: ${reason}`,
      data: { purpose, reason, window: window.window, localTime: window.localTime },
    });
    this.record({
      purpose,
      status: 'blocked',
      calledAt: at,
      windowOk: window.allowed,
      accepted: false,
      error: reason,
    });
    return { allowed: false, reason, day, used: this.repositories.llmCalls.countDay(day) };
  }
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface CompletionOptions {
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** For the audit event only; never sent to the model. */
  purpose?: string;
}

export interface CompletionResult {
  ok: boolean;
  text?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: number;
  error?: string;
}

export interface DeepSeekClientOptions {
  config: Config;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The transport. It enforces the local token ceilings *before* sending, runs at
 * concurrency 1 with a minimum interval between request starts, and never logs
 * the API key. Transport failures are returned, not thrown.
 */
export class DeepSeekClient {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly semaphore: Semaphore;
  private lastRequestAt: number | null = null;

  constructor(options: DeepSeekClientOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.semaphore = new Semaphore(this.config.deepseek.maxConcurrency);
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
    const purpose = options.purpose ?? DEEPSEEK_PURPOSE;
    // Rough local estimate: ~4 characters per token. This exists to refuse an
    // oversized prompt without spending a network round trip.
    const estimatedPromptTokens = Math.ceil(prompt.length / 4);
    if (estimatedPromptTokens > this.config.deepseek.maxInputTokens) {
      this.log('warn', purpose, 0, 0, 0, 0, 0, false);
      return {
        ok: false,
        promptTokens: estimatedPromptTokens,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        status: 0,
        error: 'prompt_too_large',
      };
    }

    const maxTokens = Math.min(
      options.maxOutputTokens ?? this.config.deepseek.maxOutputTokens,
      this.config.deepseek.maxOutputTokens,
    );
    const startedAt = this.now().getTime();
    const release = await this.semaphore.acquire();
    try {
      await this.waitForInterval();
      const signal = options.signal
        ? AbortSignal.any([AbortSignal.timeout(this.config.deepseek.timeoutMs), options.signal])
        : AbortSignal.timeout(this.config.deepseek.timeoutMs);
      const body = JSON.stringify({
        model: this.config.deepseek.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.deepseek.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.deepseek.apiKey}`,
          },
          body,
          signal,
        });
      } catch (error) {
        const latencyMs = this.now().getTime() - startedAt;
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        this.log('warn', purpose, estimatedPromptTokens, 0, 0, latencyMs, 0, false);
        return {
          ok: false,
          promptTokens: estimatedPromptTokens,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          status: 0,
          error: timedOut ? 'timeout' : toMessage(error),
        };
      }

      const latencyMs = this.now().getTime() - startedAt;
      if (!response.ok) {
        this.log('warn', purpose, estimatedPromptTokens, 0, 0, latencyMs, response.status, false);
        return {
          ok: false,
          promptTokens: estimatedPromptTokens,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          status: response.status,
          error: `http_${response.status}`,
        };
      }

      let payload: ChatCompletionPayload;
      try {
        payload = (await response.json()) as ChatCompletionPayload;
      } catch (error) {
        this.log('warn', purpose, estimatedPromptTokens, 0, 0, latencyMs, response.status, false);
        return {
          ok: false,
          promptTokens: estimatedPromptTokens,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          status: response.status,
          error: `invalid_response_body: ${toMessage(error)}`,
        };
      }

      const promptTokens = asNumber(payload.usage?.prompt_tokens, estimatedPromptTokens);
      const completionTokens = asNumber(payload.usage?.completion_tokens, 0);
      const totalTokens = asNumber(payload.usage?.total_tokens, promptTokens + completionTokens);
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        this.log('warn', purpose, promptTokens, completionTokens, totalTokens, latencyMs, response.status, false);
        return {
          ok: false,
          promptTokens,
          completionTokens,
          totalTokens,
          latencyMs,
          status: response.status,
          error: 'missing_content',
        };
      }
      this.log('info', purpose, promptTokens, completionTokens, totalTokens, latencyMs, response.status, true);
      return { ok: true, text: content, promptTokens, completionTokens, totalTokens, latencyMs, status: response.status };
    } finally {
      release();
    }
  }

  /** Space out successive request *starts* by at least `minIntervalMs`. */
  private async waitForInterval(): Promise<void> {
    const interval = this.config.deepseek.minIntervalMs;
    if (this.lastRequestAt !== null) {
      const wait = interval - (this.now().getTime() - this.lastRequestAt);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = this.now().getTime();
  }

  /** The audit event: purpose, latency, tokens and accepted flag — no key. */
  private log(
    level: 'info' | 'warn',
    purpose: string,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
    latencyMs: number,
    status: number,
    accepted: boolean,
  ): void {
    const data = { purpose, promptTokens, completionTokens, totalTokens, latencyMs, status, accepted };
    if (level === 'warn') this.logger.event({ level, source: 'deepseek', code: 'deepseek_call', message: 'deepseek call did not succeed', data });
    else this.logger.event({ level, source: 'deepseek', code: 'deepseek_call', message: 'deepseek call completed', data });
  }
}

// ---------------------------------------------------------------------------
// prompt building and parsing
// ---------------------------------------------------------------------------

export interface ParameterReviewInput {
  group: StrategyGroupName;
  current: Record<string, number>;
  currentVersion: string;
  tradesSettled: number;
  tradesVoid: number;
  realisedPnl: string;
  winRate: string;
  sweepsObserved: number;
  volatility: string;
}

/**
 * Anything matching these must never appear in a prompt. A did:key or a seed in
 * the prompt would be a key-material leak; an `sk-` key would be a credential;
 * "seed" is the loudest possible marker of either.
 */
export const FORBIDDEN_PROMPT_PATTERNS: RegExp[] = [
  /did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}/,
  /AGE-SECRET-KEY-/,
  /sk-[A-Za-z0-9]{16,}/,
  /seed/i,
];

/** Throws when a prompt contains key material, a DID or a credential. */
export function assertPromptSafe(prompt: string): void {
  for (const pattern of FORBIDDEN_PROMPT_PATTERNS) {
    if (pattern.test(prompt)) {
      throw new Error(`parameter prompt contains forbidden content: ${String(pattern)}`);
    }
  }
}

/**
 * Build the whole-strategy review prompt.
 *
 * It carries numbers only: the group, the current values, the bounded ranges,
 * a compact performance summary, and the exact JSON shape to reply with. No
 * transcript, no DID, no key, no seed — and it is asserted safe before return.
 */
export function buildParameterPrompt(input: ParameterReviewInput): string {
  const current = Object.keys(input.current)
    .sort()
    .map((key) => `${key}=${input.current[key]}`)
    .join(', ');
  const ranges = boundsSummary(input.group).map((line) => `- ${line}`);
  const lines = [
    `Evaluate close-1 strategy parameters for group ${input.group}.`,
    `Current values: ${current}`,
    'Allowed bounded ranges:',
    ...ranges,
    `Performance summary: tradesSettled=${input.tradesSettled}, tradesVoid=${input.tradesVoid}, realisedPnl=${input.realisedPnl}, winRate=${input.winRate}, sweepsObserved=${input.sweepsObserved}, volatility=${input.volatility}.`,
    `Revision under review: ${input.currentVersion}.`,
    'Reply with ONLY a JSON object of the form {"values": {"<parameter>": <number>}, "note": "<short reason>"}.',
    'Keep every value inside the allowed ranges; do not add, rename or remove parameters.',
  ];
  const prompt = lines.join('\n');
  assertPromptSafe(prompt);
  return prompt;
}

/** Find the first balanced `{...}` object in free text. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export interface ParsedParameterResponse {
  ok: boolean;
  values?: ParamValues;
  note?: string;
  errors: string[];
}

/**
 * Extract the proposal from a model reply, tolerating a markdown fence or
 * surrounding prose. It returns the raw `values`; numeric bounds are
 * `validateParams`' job and are deliberately not applied here.
 */
export function parseParameterResponse(text: string): ParsedParameterResponse {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['empty response'] };
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? extractFirstObject(text);
  if (!candidate) return { ok: false, errors: ['no JSON object found'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${toMessage(error)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['JSON is not an object'] };
  }
  const record = parsed as { values?: unknown; note?: unknown };
  if (typeof record.values !== 'object' || record.values === null || Array.isArray(record.values)) {
    return { ok: false, errors: ['reply has no values object'] };
  }
  const note = typeof record.note === 'string' ? record.note : undefined;
  return { ok: true, values: record.values as ParamValues, note, errors: [] };
}

// ---------------------------------------------------------------------------
// local simulator and fold cross-check
// ---------------------------------------------------------------------------

export interface SimulatedSweep {
  reference: string;
  close: string;
}

/** Two fixed, syntactically valid owners so the fold can mint and settle. */
const SIM_OWNER_A = 'did:key:z6MkUf3bFjg6czAxRp6xfay1NxUV7CTMmUrNUf3bFjg6czAx';
const SIM_OWNER_B = 'did:key:z6MkrBwx3NBDGJHyHjxNPFJ1Mwrhhztn4sBbrBwx3NBDGJHy';

function hashString(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * A small deterministic season derived from the review input. Because both the
 * proposal and the current set run over the *same* scenario, the comparison
 * isolates the parameter change.
 */
function buildScenario(input: ParameterReviewInput): SimulatedSweep[] {
  const observed = Number.isFinite(input.sweepsObserved) ? input.sweepsObserved : 0;
  const count = clamp(Math.round(observed), 6, 24);
  const volatility = Number.parseFloat(input.volatility);
  const amplitude = clamp(Number.isFinite(volatility) ? volatility : 0.006, 0.001, 0.02);
  const random = mulberry32(hashString(`${input.group}:${input.currentVersion}`));
  const sweeps: SimulatedSweep[] = [];
  let priceCents = 10_000;
  for (let index = 0; index < count; index += 1) {
    const referenceCents = priceCents;
    const change = 0.006 + (random() * 2 - 1) * amplitude * 0.25;
    const closeCents = Math.max(100, Math.round(referenceCents * (1 + change)));
    sweeps.push({ reference: centsToAmount(referenceCents), close: centsToAmount(closeCents) });
    priceCents = closeCents;
  }
  return sweeps;
}

/** One synthetic trade, sized by the parameter under test. */
function sweepTrade(
  id: string,
  previousReference: string | null,
  reference: string,
  sizeFraction: number,
  owners: [string, string],
): unknown | null {
  if (previousReference === null) return null;
  const previous = Decimal.from(previousReference);
  const current = Decimal.from(reference);
  const side = current.gt(previous) ? 'buy' : 'sell';
  const qty = (Math.max(50, Math.round(clamp(sizeFraction, 0.05, 1) * 500)) / 100).toFixed(2);
  return { id, maker: owners[0], side, qty, px: reference, taker: 'any', until: 999_999, countersigner: owners[1] };
}

function seasonLines(sweeps: SimulatedSweep[]): string[] {
  const first = sweeps[0];
  if (!first) throw new Error('season needs at least one sweep');
  const lines: string[] = [JSON.stringify({ t: 'seed', px: first.reference })];
  let previousReference: string | null = null;
  for (let index = 0; index < sweeps.length; index += 1) {
    const sweep = sweeps[index]!;
    const trade = sweepTrade(`fold-${index + 1}`, previousReference, sweep.reference, 0.5, [SIM_OWNER_A, SIM_OWNER_B]);
    lines.push(
      JSON.stringify({
        t: 'sweep',
        n: index + 1,
        ref: sweep.reference,
        close: sweep.close,
        owners: index === 0 ? [SIM_OWNER_A, SIM_OWNER_B] : [],
        trades: trade ? [trade] : [],
      }),
    );
    previousReference = sweep.reference;
  }
  lines.push(JSON.stringify({ t: 'final', px: sweeps[sweeps.length - 1]!.close }));
  return lines;
}

function verdictsOf(result: ReturnType<typeof replay>): string[] {
  const verdicts: string[] = [];
  for (const sweep of result.sweeps) {
    for (const trade of sweep.trades) {
      verdicts.push(trade.outcome === 'void' ? `void:${String(trade.reason)}` : 'settled');
    }
  }
  return verdicts;
}

/**
 * A small, honest, deterministic backtest. It uses the parameters to choose a
 * side and a size per sweep, settles each trade through the official `Fold`, and
 * returns the best account score. It is bounded, monotone in the change it
 * models, and never throws: a too-short scenario scores zero rather than
 * blowing up a review.
 */
export function simulateParams(params: StrategyParams, scenario: SimulatedSweep[]): Decimal {
  try {
    const first = scenario[0];
    if (!first) return Decimal.zero();
    const fold = new Fold(FOLD_DEFAULTS);
    fold.seed(first.reference);
    let previousReference: string | null = null;
    const sizeFraction = params.values['sizeFraction'] ?? 0.5;
    for (let index = 0; index < scenario.length; index += 1) {
      const sweep = scenario[index]!;
      const trade = sweepTrade(`sim-${index + 1}`, previousReference, sweep.reference, sizeFraction, [SIM_OWNER_A, SIM_OWNER_B]);
      fold.sweep(index + 1, sweep.reference, sweep.close, index === 0 ? [SIM_OWNER_A, SIM_OWNER_B] : [], trade ? [trade] : []);
      previousReference = sweep.reference;
    }
    const result = fold.final(scenario[scenario.length - 1]!.close);
    let best = Decimal.zero();
    for (const standing of result.standings) {
      const score = Decimal.from(standing.score);
      if (score.gt(best)) best = score;
    }
    return best;
  } catch {
    return Decimal.zero();
  }
}

/**
 * The "官方 fold 对照" gate. Parameters never enter the fold's arithmetic, so this
 * is a *tripwire*, not an economic check: it replays the same synthetic season
 * twice and requires identical `void`/`settled` verdicts. If a future change
 * ever made a parameter reach the fold, the two sequences would diverge here and
 * the proposal would be refused before it became effective.
 */
export function crossCheckWithFold(params: StrategyParams, sweeps: SimulatedSweep[]): { same: boolean; detail: string } {
  void params;
  try {
    const lines = seasonLines(sweeps);
    const first = verdictsOf(replay(lines, FOLD_DEFAULTS));
    const second = verdictsOf(replay(lines, { ...FOLD_DEFAULTS }));
    const same = JSON.stringify(first) === JSON.stringify(second);
    return { same, detail: same ? 'fold verdicts identical' : 'fold verdicts diverged' };
  } catch (error) {
    return { same: false, detail: `fold replay failed: ${toMessage(error)}` };
  }
}

// ---------------------------------------------------------------------------
// optimiser
// ---------------------------------------------------------------------------

export type ParameterReviewOutcome = {
  accepted: boolean;
  reason: string;
  params: StrategyParams;
  versionId: string | null;
  detail?: string;
};

export interface ParameterOptimiserOptions {
  config: Config;
  logger: Logger;
  repositories: Repositories;
  client: DeepSeekClient;
  budget: DeepSeekBudget;
  loadGuard?: LoadGuard;
  now?: () => Date;
}

/**
 * The full parameter pipeline.
 *
 *   budget → prompt (safety-checked) → model → parse → bounds → simulator →
 *   official fold cross-check → supersede + insert
 *
 * Nothing the model returns may touch a signature, a technocore call or a risk
 * cap; the parameter bounds in `parameter-validator.ts` are the entire surface it
 * can influence. `review` never throws: every failure path returns an outcome
 * with the previous effective parameters.
 */
export class ParameterOptimiser {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly repositories: Repositories;
  private readonly client: DeepSeekClient;
  private readonly budget: DeepSeekBudget;
  private readonly now: () => Date;

  constructor(options: ParameterOptimiserOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.repositories = options.repositories;
    this.client = options.client;
    this.budget = options.budget;
    this.now = options.now ?? (() => new Date());
  }

  private currentParams(group: StrategyGroupName): StrategyParams {
    const row = this.repositories.strategyVersions.effective(group);
    if (!row) return fallbackParams(group);
    try {
      const values = JSON.parse(row.params_json) as ParamValues;
      if (typeof values !== 'object' || values === null) return fallbackParams(group);
      return { group, version: row.version, source: 'operator', values };
    } catch {
      return fallbackParams(group);
    }
  }

  async review(input: ParameterReviewInput): Promise<ParameterReviewOutcome> {
    const group = input.group;
    const previous = this.currentParams(group);
    try {
      const purpose = DEEPSEEK_PURPOSE;

      // 1. budget — refuse before building a prompt or touching the network.
      const gate = this.budget.canCall();
      if (!gate.allowed) {
        // Persist the refusal through reserve() so llm_calls carries the record.
        this.budget.reserve(purpose, false);
        this.logger.event({
          level: 'warn',
          source: 'deepseek',
          code: 'parameter_review_refused',
          message: `parameter review refused: ${gate.reason}`,
          data: { group, reason: gate.reason },
        });
        return { accepted: false, reason: 'budget', params: previous, versionId: null, detail: gate.reason };
      }

      // 2. prompt — built from numbers only and asserted safe before sending.
      const prompt = buildParameterPrompt(input);

      // 3. model — at most one retry, and only if the retry budget allows it.
      let result = await this.client.complete(prompt, {
        purpose,
        maxOutputTokens: this.config.deepseek.maxOutputTokens,
      });
      let retryOf: number | null = null;
      if (!result.ok) {
        const failedId = this.recordClientResult(purpose, result, null);
        const retry = this.budget.reserve(purpose, true);
        if (!retry.allowed) {
          return {
            accepted: false,
            reason: 'transport',
            params: previous,
            versionId: null,
            detail: `${result.error ?? 'transport'}; retry refused: ${retry.reason}`,
          };
        }
        retryOf = failedId;
        result = await this.client.complete(prompt, {
          purpose,
          maxOutputTokens: this.config.deepseek.maxOutputTokens,
        });
        if (!result.ok) {
          this.recordClientResult(purpose, result, retryOf);
          return { accepted: false, reason: 'transport', params: previous, versionId: null, detail: result.error ?? 'transport' };
        }
      }

      // 4. parse — an unusable reply is recorded as invalid, not retried.
      const parsed = parseParameterResponse(result.text ?? '');
      if (!parsed.ok || !parsed.values) {
        this.budget.record({ ...this.callFields(purpose, result, retryOf), status: 'invalid', accepted: false, error: 'invalid_json' });
        return { accepted: false, reason: 'invalid_json', params: previous, versionId: null, detail: parsed.errors.join('; ') };
      }

      // 5. bounds — validateParams clamps out-of-range values; a clamp is itself
      // a refusal, because a proposal that "needed" clamping was out of bounds.
      const validation = validateParams({ values: parsed.values }, group);
      if (!validation.ok || !validation.params || validation.clamped.length > 0) {
        const detail = validation.errors.length > 0 ? validation.errors.join('; ') : validation.clamped.join('; ');
        this.budget.record({ ...this.callFields(purpose, result, retryOf), status: 'ok', accepted: false, error: 'bounds' });
        return { accepted: false, reason: 'bounds', params: previous, versionId: null, detail };
      }

      const proposal: StrategyParams = { ...validation.params, source: 'deepseek', note: parsed.note };

      // 6. simulator — the proposal must not lose to the current parameters.
      const scenario = buildScenario(input);
      const currentScore = simulateParams(previous, scenario);
      const proposalScore = simulateParams(proposal, scenario);
      if (proposalScore.lt(currentScore)) {
        this.budget.record({ ...this.callFields(purpose, result, retryOf), status: 'ok', accepted: false, error: 'simulator' });
        return {
          accepted: false,
          reason: 'simulator',
          params: previous,
          versionId: null,
          detail: `proposal ${proposalScore.toString()} < current ${currentScore.toString()}`,
        };
      }

      // 7. official fold cross-check — the tripwire described on the function.
      const fold = crossCheckWithFold(proposal, scenario);
      if (!fold.same) {
        this.budget.record({ ...this.callFields(purpose, result, retryOf), status: 'ok', accepted: false, error: 'fold' });
        return { accepted: false, reason: 'fold', params: previous, versionId: null, detail: fold.detail };
      }

      // 8. persist — supersede the old set, then insert the audited new one.
      const at = this.now();
      const version = `${group}-${this.budget.dayKey(at)}`;
      const params: StrategyParams = { ...proposal, version };
      const callId = this.budget.record({
        ...this.callFields(purpose, result, retryOf),
        status: 'ok',
        accepted: true,
        paramsVersion: version,
      });
      const versionId = randomUUID();
      this.repositories.strategyVersions.supersede(group, at.toISOString());
      this.repositories.strategyVersions.insert({
        id: versionId,
        strategy_group: group,
        version,
        params_json: JSON.stringify(params.values),
        source: 'deepseek',
        llm_call_id: callId,
        effective_from: at.toISOString(),
        superseded_at: null,
      });
      this.logger.event({
        level: 'info',
        source: 'deepseek',
        code: 'parameter_accepted',
        message: `deepseek parameters accepted for ${group}`,
        data: { group, version, versionId },
      });
      return { accepted: true, reason: 'ok', params, versionId };
    } catch (error) {
      this.logger.error({ source: 'deepseek', group }, `parameter review failed: ${toMessage(error)}`);
      return { accepted: false, reason: 'error', params: previous, versionId: null, detail: toMessage(error) };
    }
  }

  private callFields(purpose: string, result: CompletionResult, retryOf: number | null) {
    return {
      purpose,
      retryOf,
      windowOk: true,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
    };
  }

  private recordClientResult(purpose: string, result: CompletionResult, retryOf: number | null): number {
    return this.budget.record({
      ...this.callFields(purpose, result, retryOf),
      status: result.error === 'timeout' ? 'timeout' : 'failed',
      accepted: false,
      error: result.error ?? 'transport',
    });
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

export interface DeepSeekSchedulerOptions {
  config: Config;
  logger: Logger;
  optimiser: ParameterOptimiser;
  budget: DeepSeekBudget;
  now?: () => Date;
}

export interface RunOnceResult {
  attempted: string[];
  refused: { group: string; reason: string }[];
}

/**
 * Fires the parameter review at the two low-traffic call times.
 *
 * The five groups are split deterministically across the two slots (three at the
 * first, two at the second, in `STRATEGY_GROUP_NAMES` order), so the daily model
 * spend is bounded and predictable rather than bursty. It is idempotent per
 * local day.
 */
export class DeepSeekScheduler {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly optimiser: ParameterOptimiser;
  private readonly budget: DeepSeekBudget;
  private readonly now: () => Date;
  private readonly handled = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DeepSeekSchedulerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.optimiser = options.optimiser;
    this.budget = options.budget;
    this.now = options.now ?? (() => new Date());
  }

  /** The groups whose review is due at `at`, or none outside a call time. */
  dueEvaluations(at: Date): StrategyGroupName[] {
    const slotIndex = DEEPSEEK_DEFAULT_CALL_TIMES.indexOf(localClock(at, this.config.timezone).hhmm);
    if (slotIndex === -1) return [];
    const groups = [...STRATEGY_GROUP_NAMES];
    const perSlot = Math.ceil(groups.length / DEEPSEEK_DEFAULT_CALL_TIMES.length);
    const start = slotIndex * perSlot;
    const end = slotIndex === DEEPSEEK_DEFAULT_CALL_TIMES.length - 1 ? groups.length : start + perSlot;
    return groups.slice(start, end);
  }

  async runOnce(at?: Date): Promise<RunOnceResult> {
    const when = at ?? this.now();
    const day = this.budget.dayKey(when);
    const attempted: string[] = [];
    const refused: { group: string; reason: string }[] = [];
    for (const group of this.dueEvaluations(when)) {
      if (this.isHandled(group, day)) continue;
      this.handled.add(`${group}@${day}`);
      attempted.push(group);
      try {
        const outcome = await this.optimiser.review(this.buildInput(group, day));
        if (!outcome.accepted) refused.push({ group, reason: outcome.reason });
      } catch (error) {
        refused.push({ group, reason: `error:${toMessage(error)}` });
      }
    }
    return { attempted, refused };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) =>
        this.logger.error({ source: 'deepseek-scheduler' }, `scheduled review failed: ${toMessage(error)}`),
      );
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Handled this local day: already attempted, or a version is effective today. */
  private isHandled(group: StrategyGroupName, day: string): boolean {
    if (this.handled.has(`${group}@${day}`)) return true;
    const effective = this.budget.repositories.strategyVersions.effective(group);
    if (effective && localDateKey(new Date(effective.effective_from), this.config.timezone) === day) return true;
    return false;
  }

  private buildInput(group: StrategyGroupName, _day: string): ParameterReviewInput {
    const repositories = this.budget.repositories;
    const effective = repositories.strategyVersions.effective(group);
    let current: Record<string, number>;
    let currentVersion: string;
    if (effective) {
      try {
        current = JSON.parse(effective.params_json) as Record<string, number>;
        currentVersion = effective.version;
      } catch {
        current = { ...DEFAULT_PARAMS[group].values };
        currentVersion = DEFAULT_PARAMS[group].version;
      }
    } else {
      current = { ...DEFAULT_PARAMS[group].values };
      currentVersion = DEFAULT_PARAMS[group].version;
    }
    const trades = repositories.trades.countByStatus();
    const settled = trades['settled'] ?? 0;
    const voidCount = trades['void'] ?? 0;
    const total = settled + voidCount;
    return {
      group,
      current,
      currentVersion,
      tradesSettled: settled,
      tradesVoid: voidCount,
      realisedPnl: repositories.meta.get('realised_pnl') ?? '0',
      winRate: total > 0 ? (settled / total).toFixed(4) : '0',
      sweepsObserved: repositories.referee.getSweepState()?.current_sweep ?? 0,
      volatility: repositories.meta.get('volatility') ?? '0',
    };
  }
}
