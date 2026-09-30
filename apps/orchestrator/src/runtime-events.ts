/**
 * Runtime event alerts.
 *
 * The MVP keeps two things an operator needs from an unattended box: a periodic
 * status report, and an *immediate* short alert when something goes wrong. This
 * file is the second half.
 *
 * The design is deliberately thin:
 *
 *   - it observes the existing structured log rather than adding a parallel
 *     event bus, so every code already emitted anywhere in the process is
 *     eligible and nothing has to be threaded through;
 *   - it records each event once in `runtime_events`, keyed by a deterministic
 *     `event_id`, so a restart that re-observes the same condition neither
 *     duplicates the row nor re-alerts;
 *   - it pushes the alert through the *same* durable Lark outbox the daily
 *     report uses, which already owns retry and the report-id dedupe. A Lark
 *     outage therefore only delays alerts; it never loses them and never blocks
 *     the tick.
 *
 * Nothing here calls a model, reads the archive, or touches the market snapshot.
 */
import type { Repositories } from '@flop/storage';
import type { EventRecord, Logger } from './logger.js';
import type { LarkOutbox } from './lark.js';

export type RuntimeSeverity = 'critical' | 'warning';

/**
 * The event catalogue: which codes the operator must be told about, and how
 * loudly. A code that is not listed is logged and persisted as usual but never
 * pushed to Lark — the noise floor stays at "something you would act on".
 */
export const RUNTIME_EVENT_SEVERITY: Record<string, RuntimeSeverity> = {
  // ---- critical: something is wrong now ----------------------------------
  package_hash_drift: 'critical',
  // The verifier entering conservative mode is the umbrella for a referee DID
  // mismatch, a missing seed and an expected-package-hash mismatch; its message
  // names which, and none of them may pass silently.
  conservative_mode: 'critical',
  sqlite_corrupt: 'critical',
  disk_critical: 'critical',
  disk_readonly: 'critical',
  cursor_gap: 'critical',
  room_reset: 'critical',
  unhandled_rejection: 'critical',
  uncaught_exception: 'critical',
  lark_report_failed: 'critical',
  registration_closed: 'critical',
  owner_registration_closed: 'critical',
  owner_registration_failed: 'critical',

  // ---- warning: worth knowing, not worth waking anyone --------------------
  mint_unknown: 'warning',
  // A first start against a room whose retained history does not reach back to
  // seq 1. Not a loss this process suffered, so it is not `cursor_gap` — but it
  // is permanent, and it must never be mistaken for a complete history.
  bootstrap_truncated: 'warning',
  archive_unavailable: 'warning',
  archive_hash_mismatch: 'warning',
  archive_verify_failed: 'warning',
  archive_check_failed: 'warning',
  referee_missed: 'warning',
  referee_omitted: 'warning',
  room_unlisted: 'warning',
  room_overflow: 'warning',
  stale_reference: 'warning',
  limits_for_missing: 'warning',
  applied_missing: 'warning',
  trade_aborted: 'warning',
  external_offer_refused: 'warning',
  repost_unmatched: 'warning',
  agent_run_failed: 'warning',
  write_rejected: 'warning',
  write_shed: 'warning',
  room_read_degraded: 'warning',
  watchdog_deferred: 'warning',
  upstream_check_failed: 'warning',
  lark_report_send_failed: 'warning',
  lark_report_send_error: 'warning',
  deepseek_disabled: 'warning',
  deepseek_blocked: 'warning',
  duplicate_trade_id: 'warning',
};

/** A Lark text message is capped; an alert is a pointer, not a document. */
export const ALERT_MAX_LENGTH = 500;

export interface RuntimeEventNotifierOptions {
  repositories: Repositories;
  logger: Logger;
  outbox: LarkOutbox;
  now?: () => Date;
}

export interface AlertContext {
  sweep?: number | null;
  agentId?: string | null;
}

export class RuntimeEventNotifier {
  private readonly repositories: Repositories;
  private readonly logger: Logger;
  private readonly outbox: LarkOutbox;
  private readonly now: () => Date;

  constructor(options: RuntimeEventNotifierOptions) {
    this.repositories = options.repositories;
    this.logger = options.logger;
    this.outbox = options.outbox;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The event id that makes an alert at-most-once.
   *
   * A critical carries its sweep, because two cursor gaps at two sweeps are two
   * facts. A warning deliberately does not: a condition that holds for every
   * sweep (a stale reference, an unreachable archive) would otherwise produce a
   * message every five minutes, and an operator who mutes the channel has lost
   * the criticals too.
   */
  static eventIdFor(severity: RuntimeSeverity, code: string, context: AlertContext): string {
    const agent = context.agentId ?? '-';
    if (severity === 'critical') return `${code}:${agent}:${context.sweep ?? '-'}`;
    return `${code}:${agent}`;
  }

  private static reportIdFor(eventId: string): string {
    return `event:${eventId}`;
  }

  /** The severity this code is alerted at, or null when it is not in the catalogue. */
  static severityOf(code: string): RuntimeSeverity | null {
    return RUNTIME_EVENT_SEVERITY[code] ?? null;
  }

  /** Log-observer entry point. Never throws: it runs inside the logger. */
  observe(record: EventRecord): void {
    const severity = RuntimeEventNotifier.severityOf(record.code);
    if (severity === null) return;
    const data = (record.data ?? {}) as Record<string, unknown>;
    this.alert(severity, record.code, record.message, {
      sweep: typeof data.sweep === 'number' ? data.sweep : null,
      agentId: typeof data.agentId === 'string' ? data.agentId : null,
    });
  }

  /**
   * Record the event and queue one Lark alert for it.
   *
   * Returns false when this event was already recorded, which is also the signal
   * that nothing was queued: the same event is never alerted twice.
   */
  alert(
    severity: RuntimeSeverity,
    code: string,
    message: string,
    context: AlertContext = {},
  ): boolean {
    const eventId = RuntimeEventNotifier.eventIdFor(severity, code, context);
    const inserted = this.repositories.runtimeEvents.record({
      event_id: eventId,
      severity,
      code,
      message,
      sweep: context.sweep ?? null,
      agent_id: context.agentId ?? null,
      created_at: this.now().toISOString(),
      lark_status: 'none',
    });
    if (!inserted) return false;

    this.enqueue(eventId, severity, code, message, context);
    return true;
  }

  private enqueue(
    eventId: string,
    severity: RuntimeSeverity,
    code: string,
    message: string,
    context: AlertContext,
  ): void {
    const text = RuntimeEventNotifier.render(severity, code, message, context);
    let queued = false;
    try {
      queued = this.outbox.enqueue(RuntimeEventNotifier.reportIdFor(eventId), 'runtime_event', text);
    } catch (error) {
      // A failure to queue is recorded on the event row and retried on the next
      // flush; it must never propagate into the caller.
      this.repositories.runtimeEvents.markLarkStatus(eventId, 'failed');
      this.logger.warn(
        { code, error: error instanceof Error ? error.message : String(error) },
        'could not queue a runtime alert; it stays pending in runtime_events',
      );
      return;
    }
    this.repositories.runtimeEvents.markLarkStatus(eventId, queued ? 'pending' : 'sent');
  }

  /** The short, secret-free alert body. */
  static render(
    severity: RuntimeSeverity,
    code: string,
    message: string,
    context: AlertContext,
  ): string {
    const where = [
      context.sweep === undefined || context.sweep === null ? null : `sweep ${context.sweep}`,
      context.agentId ? `agent ${context.agentId}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');
    const head = severity === 'critical' ? '🚨 CRITICAL' : '⚠ WARNING';
    const body = `${head} ${code}${where ? ` (${where})` : ''}\n${message}`;
    return body.length > ALERT_MAX_LENGTH ? `${body.slice(0, ALERT_MAX_LENGTH - 1)}…` : body;
  }

  /**
   * Bring `runtime_events.lark_status` in step with the outbox, then flush.
   *
   * The outbox owns the send; this only mirrors the outcome, re-queues an alert
   * whose outbox row was dropped, and then lets the outbox deliver. Safe to call
   * on a timer: an unchanged row is a no-op.
   */
  async flush(limit = 100): Promise<{ sent: number; failed: number }> {
    // Re-queue any alert whose outbox row was dropped (a manual cleanup, a lost
    // file) before the outbox sends, so the alert is not stranded.
    for (const row of this.repositories.runtimeEvents.unsettled(limit)) {
      if (this.repositories.larkOutbox.byReportId(RuntimeEventNotifier.reportIdFor(row.event_id))) {
        continue;
      }
      this.enqueue(row.event_id, row.severity, row.code, row.message, {
        sweep: row.sweep,
        agentId: row.agent_id,
      });
    }

    const result = await this.outbox.flush(limit);

    // Mirror the outcome *after* the send, so `lark_status` is correct as soon as
    // the flush returns rather than one pass later.
    for (const row of this.repositories.runtimeEvents.unsettled(limit)) {
      const outboxRow = this.repositories.larkOutbox.byReportId(
        RuntimeEventNotifier.reportIdFor(row.event_id),
      );
      if (!outboxRow) continue;
      if (outboxRow.status === 'sent') {
        this.repositories.runtimeEvents.markLarkStatus(row.event_id, 'sent', outboxRow.attempts);
      } else if (outboxRow.status === 'failed') {
        this.repositories.runtimeEvents.markLarkStatus(row.event_id, 'failed', outboxRow.attempts);
      }
    }
    return result;
  }

  counts(): Record<string, number> {
    return this.repositories.runtimeEvents.countBySeverity();
  }
}

/**
 * The report-facing view of the runtime event trail.
 *
 * Kept as a free function so the report builder can call it without holding a
 * notifier, and so a test can assert the shape directly.
 */
export function runtimeEventSummary(repositories: Repositories): {
  total: number;
  critical: number;
  warning: number;
  delivered: number;
  pending: number;
  failed: number;
  recentCodes: string[];
} {
  const bySeverity = repositories.runtimeEvents.countBySeverity();
  const byLark = repositories.runtimeEvents.countByLarkStatus();
  const recent = repositories.runtimeEvents.recent(5);
  return {
    total: repositories.runtimeEvents.count(),
    critical: bySeverity.critical ?? 0,
    warning: bySeverity.warning ?? 0,
    delivered: byLark.sent ?? 0,
    pending: (byLark.pending ?? 0) + (byLark.none ?? 0),
    failed: byLark.failed ?? 0,
    recentCodes: recent.map((row) => `${row.severity}:${row.code}`),
  };
}
