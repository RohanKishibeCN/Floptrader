/**
 * The new risk knobs, and how they fail closed.
 *
 * These came out of the referee behaviour doc and the review: a stale-reference
 * limit, a mode for it, three ceilings on external offers, a cap on discovered
 * rooms, and the archive location. Every one of them is validated at startup, so
 * a typo is a refusal to start rather than a surprise during a live sweep.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../apps/orchestrator/src/config.js';

function load(env: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
}

describe('the stale-reference knobs', () => {
  it('defaults to a 60s limit and no_new_active_trade', () => {
    const config = load();
    expect(config.risk.maxReferenceAgeSeconds).toBe(60);
    expect(config.risk.staleReferenceMode).toBe('no_new_active_trade');
  });

  it('accepts an explicit limit and the off switch', () => {
    const config = load({ MAX_REFERENCE_AGE_SECONDS: '120', STALE_REFERENCE_MODE: 'off' });
    expect(config.risk.maxReferenceAgeSeconds).toBe(120);
    expect(config.risk.staleReferenceMode).toBe('off');
  });

  it('refuses an unknown mode', () => {
    expect(() => load({ STALE_REFERENCE_MODE: 'panic' })).toThrow(ConfigError);
  });
});

describe('the external-offer ceilings', () => {
  it('parses the three numbers as exact decimals', () => {
    const config = load({
      MAX_EXTERNAL_OFFER_QTY: '12',
      MAX_EXTERNAL_OFFER_NOTIONAL: '3600.50',
      MAX_CLAWBACK_BUFFER: '25',
    });
    expect(config.risk.externalOffer.maxQty.toString()).toBe('12');
    expect(config.risk.externalOffer.maxNotional.toString()).toBe('3600.50');
    expect(config.risk.externalOffer.clawbackBuffer.toString()).toBe('25');
  });

  it('refuses a non-numeric ceiling instead of defaulting it', () => {
    expect(() => load({ MAX_EXTERNAL_OFFER_QTY: 'lots' })).toThrow(ConfigError);
    expect(() => load({ MAX_CLAWBACK_BUFFER: '1,5' })).toThrow(ConfigError);
  });

  it('refuses a non-positive ceiling and a negative buffer', () => {
    expect(() => load({ MAX_EXTERNAL_OFFER_QTY: '0' })).toThrow(ConfigError);
    expect(() => load({ MAX_EXTERNAL_OFFER_NOTIONAL: '-1' })).toThrow(ConfigError);
    expect(() => load({ MAX_CLAWBACK_BUFFER: '-1' })).toThrow(ConfigError);
  });

  it('allows a zero buffer: it is a margin, not a requirement', () => {
    expect(load({ MAX_CLAWBACK_BUFFER: '0' }).risk.externalOffer.clawbackBuffer.isZero()).toBe(true);
  });
});

describe('the room and archive knobs', () => {
  it('carries a discoverable-room cap and refuses a nonsensical one', () => {
    expect(load().roomDiscovery.maxRooms).toBe(50);
    expect(load({ MAX_DISCOVERED_ROOMS: '10' }).roomDiscovery.maxRooms).toBe(10);
    expect(() => load({ MAX_DISCOVERED_ROOMS: '0' })).toThrow(ConfigError);
  });

  it('points at the published archive and normalises the trailing slash', () => {
    expect(load().archive.baseUrl).toBe('https://challenges.technocore.chat/close-1');
    expect(load({ CHALLENGE_ARCHIVE_BASE_URL: 'https://example.test/close-1/' }).archive.baseUrl).toBe(
      'https://example.test/close-1',
    );
    expect(load().archive.checkIntervalMinutes).toBe(15);
  });
});
