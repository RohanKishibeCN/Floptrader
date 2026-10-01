/**
 * The lite profile.
 *
 * `lite` is the deployable contest configuration: one process, 150 DIDs, close-1,
 * registration, deterministic trades, durable evidence and Lark. It is a
 * *convergence*, not an exemption — it closes the operational extras that would
 * otherwise sit near the trade loop, and it never relaxes a live gate.
 *
 * These tests pin the three convergences and, just as importantly, that what lite
 * keeps — reports, alerts, the pins, the full fleet — is still there and still
 * recorded the same way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../apps/orchestrator/src/config.js';
import { HARNESS_PACKAGE_HASH, buildHarness, type Harness } from './support/orchestrator.js';

const CLEAN = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

describe('the lite profile is the default', () => {
  it('defaults to lite when nothing is asked for', () => {
    const config = loadConfig(CLEAN);
    expect(config.profile).toBe('lite');
    expect(config.profileOverrides).toEqual([]);
  });

  it('turns the model lane, dynamic rooms and external offers off', () => {
    const config = loadConfig(CLEAN);
    expect(config.deepseek.enabled).toBe(false);
    expect(config.roomDiscovery.maxRooms).toBe(0);
    expect(config.externalOfferTakerEnabled).toBe(false);
  });

  it('keeps Lark on the Open API and the inbound socket off', () => {
    const config = loadConfig(CLEAN);
    expect(config.lark.mode).toBe('open-api');
    expect(config.lark.websocketEnabled).toBe(false);
    // The socket is doubly gated: both the mode and the flag must opt in.
    expect(loadConfig({ ...CLEAN, LARK_WS_ENABLED: 'true' }).lark.websocketEnabled).toBe(false);
    expect(
      loadConfig({ ...CLEAN, LARK_MODE: 'websocket', LARK_WS_ENABLED: 'true' }).lark.websocketEnabled,
    ).toBe(true);
  });

  it('overrides a requested setting rather than silently ignoring it', () => {
    const config = loadConfig({
      ...CLEAN,
      DEEPSEEK_ENABLED: 'true',
      EXTERNAL_OFFER_TAKER_ENABLED: 'true',
      MAX_DISCOVERED_ROOMS: '10',
    });
    expect(config.deepseek.enabled).toBe(false);
    expect(config.externalOfferTakerEnabled).toBe(false);
    expect(config.roomDiscovery.maxRooms).toBe(0);
    // Every override is on the record, so the operator can see what changed.
    expect(config.profileOverrides.join('\n')).toContain('DEEPSEEK_ENABLED');
    expect(config.profileOverrides.join('\n')).toContain('EXTERNAL_OFFER_TAKER_ENABLED');
    expect(config.profileOverrides.join('\n')).toContain('MAX_DISCOVERED_ROOMS=0');
  });

  it('leaves the full profile exactly as it was', () => {
    const config = loadConfig({ ...CLEAN, FLOP_PROFILE: 'full', DEEPSEEK_ENABLED: 'true' });
    expect(config.profile).toBe('full');
    expect(config.profileOverrides).toEqual([]);
    expect(config.deepseek.enabled).toBe(true);
    expect(config.roomDiscovery.maxRooms).toBe(10);
  });

  it('never relaxes a live gate: lite still refuses an unpinned live process', () => {
    // The gate is unchanged by the profile: live without a pinned referee DID is
    // still a refusal to start, under lite as much as under full.
    expect(() =>
      loadConfig({
        ...CLEAN,
        FLOP_MODE: 'live',
        FLOP_LIVE_CONFIRM: 'close-1',
        FLOP_ALLOW_REGISTRATION: 'true',
        EXPECTED_PACKAGE_HASH: 'a'.repeat(64),
      }),
    ).toThrow(ConfigError);
  });
});

/** The lite environment the tests below run against. */
const LITE_ENV = {
  FLOP_PROFILE: 'lite',
  LARK_MODE: 'open-api',
  LARK_WS_ENABLED: 'false',
  LARK_APP_ID: 'cli-lite',
  LARK_APP_SECRET: 'lark-secret-sentinel',
  LARK_CHAT_ID: 'oc-lite',
} as const;

describe('a lite runtime', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.dispose();
    harness = null;
  });

  it('reports the profile, the fixed room scope and the full fleet', async () => {
    harness = await buildHarness({ env: { ...LITE_ENV } });
    const status = harness.runtime.scheduler.status();

    expect(status.profile).toBe('lite');
    // Fixed six rooms only: the report says so, and no owner room is claimed.
    expect(status.rooms.scope).toBe('close1_only');
    expect(status.rooms.cap).toBe(0);
    expect(status.rooms.dynamic).toEqual([]);
    expect(status.rooms.fixed).toContain('close1');

    // The fleet is untouched by the profile: 150 DIDs, five groups of thirty.
    expect(status.agents.total).toBe(150);
    expect(status.agents.byGroup).toEqual({
      trend_following: 30,
      mean_reversion: 30,
      breakout: 30,
      contrarian: 30,
      external_offer_taker: 30,
    });
  });

  it('keeps the non-core background work out of the tick', async () => {
    harness = await buildHarness({ agentCount: 6, env: { ...LITE_ENV } });
    const h = harness;

    const tick = await h.runtime.scheduler.runTick();

    // The tick still reads and reconciles; it just does not wait on the audit
    // sources. No upstream check, no model slot, no discovery.
    expect(tick.upstream.checked).toBe(false);
    expect(tick.deepseek.attempted).toEqual([]);
    expect(tick.rooms.readErrors).toBe(0);
  });

  it('keeps the package and referee pins that live trading depends on', async () => {
    harness = await buildHarness({ agentCount: 6, env: { ...LITE_ENV } });
    const h = harness;

    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.packageHash).toBe(HARNESS_PACKAGE_HASH);
    expect(status.packageDrift).toBe(false);
    expect(status.refereeDid).toBeTruthy();
    expect(h.runtime.config.expectedRefereeDid).toBe(status.refereeDid);
  });

  it('keeps registration and readback evidence intact', async () => {
    harness = await buildHarness({ agentCount: 6, env: { ...LITE_ENV } });
    const h = harness;

    await h.runtime.scheduler.ensureParticipation();
    // Readback is what turns a post into evidence; the reader supplies it.
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.participation.total).toBe(6);
    expect(status.participation.readback).toBe(6);
    expect(h.runtime.repositories.participation.ownerRegistrationCount()).toBe(6);
  });

  it('still sends the daily Lark report, and the report says what lite means', async () => {
    // 00:50Z is 08:50 Asia/Shanghai, one of the two configured report times.
    harness = await buildHarness({
      agentCount: 6,
      now: () => new Date('2026-09-28T00:50:00Z'),
      env: { ...LITE_ENV },
    });
    const h = harness;

    await h.runtime.scheduler.runTick();

    expect(h.lark.sent).toHaveLength(1);
    const text = h.lark.sent[0]!;
    expect(text).toContain('运行报告');
    expect(text).toContain('profile: lite');
    expect(text).toContain('room_scope: close1_only');
    expect(text).toContain('运行事件');
    // The outbox row is the durable record of the delivery.
    expect(h.runtime.repositories.larkOutbox.countByStatus().sent).toBe(1);
  });

  it('renders a status report for the current sweep with no secrets and no DID wall', async () => {
    harness = await buildHarness({
      agentCount: 6,
      env: { ...LITE_ENV, DEEPSEEK_API_KEY: 'deepseek-key-sentinel' },
    });
    const h = harness;

    h.referee.seedPost(HARNESS_PACKAGE_HASH);
    h.referee.price(1, '225.10');
    await h.runtime.scheduler.runTick();

    const status = h.runtime.scheduler.status();
    expect(status.sweep).toBe(1);

    const report = await h.runtime.scheduler.buildReport();
    const rendered = `${report.title}\n${report.summary}\n${report.sections
      .map((section) => `${section.heading}\n${section.lines.join('\n')}`)
      .join('\n')}`;

    // The report goes out as a Lark *text* message and is truncated past 4000
    // characters, so growth in any section is silent until it costs another
    // section its middle. This fixture is fully deterministic, which makes the
    // budget checkable rather than merely hoped for.
    expect(rendered.length).toBeLessThan(4000);
    expect(rendered).toContain('current_sweep: 1');
    expect(rendered).toContain('profile: lite');
    expect(rendered).toContain('total_agents: 6');
    // The reader's throughput has to be legible in the report, and the two
    // figures that answer "are we keeping up" have to be separate ones: the
    // producer rate is the room's own growth, the persisted rate is what reached
    // SQLite, the cursor-advance rate is only how far the cursor *number* moved,
    // and the gap that is still open is named on its own.
    expect(rendered).toContain('rates/min:');
    expect(rendered).toContain('producer');
    expect(rendered).toContain('persisted');
    expect(rendered).toContain('cursor-adv');
    expect(rendered).toContain('net persisted backlog/min:');
    expect(rendered).toContain('catch-up:');
    expect(rendered).toContain('unresolved gap:');
    expect(rendered).toContain('fully-caught-up:');
    expect(rendered).toContain('export:');
    expect(rendered).toContain('fairness:');

    // Nothing secret may survive into the report: not the Lark app secret, not
    // the model key, not a seed, not the private key.
    expect(rendered).not.toContain('lark-secret-sentinel');
    expect(rendered).not.toContain('deepseek-key-sentinel');
    expect(rendered.toLowerCase()).not.toContain('age-secret-key');
    expect(rendered).not.toContain('"seed"');
    expect(rendered).not.toContain('privateKey');
    // And no wall of DIDs: the report may name the referee, never 150 agents.
    for (const line of rendered.split('\n')) {
      expect(line.split('did:key:').length - 1).toBeLessThan(2);
    }
  });

  it('pushes a critical runtime event through the same durable outbox', async () => {
    harness = await buildHarness({ agentCount: 6, env: { ...LITE_ENV } });
    const h = harness;

    expect(h.runtime.notifier.alert('critical', 'cursor_gap', 'a cursor gap in close1', { sweep: 9 }))
      .toBe(true);
    await h.runtime.notifier.flush();

    expect(h.lark.sent).toHaveLength(1);
    expect(h.lark.sent[0]).toContain('CRITICAL');
    expect(h.lark.sent[0]).toContain('cursor_gap');
    expect(h.runtime.repositories.runtimeEvents.recent(1)[0]!.lark_status).toBe('sent');

    // The status report carries the event trail, so an operator reading the daily
    // report also sees the alert that was pushed during the day.
    const report = await h.runtime.scheduler.buildReport();
    const events = report.sections.find((section) => section.heading.includes('运行事件'));
    expect(events?.lines.join('\n')).toContain('critical:cursor_gap');
  });
});
