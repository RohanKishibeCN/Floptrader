/**
 * The systemd unit as a checked artifact.
 *
 * `systemd-analyze verify` is the real gate and the VPS smoke runs it when the
 * host has systemd. This test is the offline half: it pins the things a verify
 * either cannot see or that are easy to move into the wrong section — above all
 * `StartLimitIntervalSec`/`StartLimitBurst`, which systemd reads from `[Unit]`
 * only. Under `[Service]` they are an "Unknown key name": a warning on some
 * versions, silently ignored on others, and either way the crash-loop bound the
 * unit exists to enforce is not in force.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UNIT_PATH = join(process.cwd(), 'systemd', 'flop-close-call.service');
const RAW = readFileSync(UNIT_PATH, 'utf8');

/** Split an INI-ish unit file into `section -> [lines]`. */
function sections(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1]!;
      if (!result.has(current)) result.set(current, []);
      continue;
    }
    result.get(current)?.push(line);
  }
  return result;
}

/** Every directive in a section, as `key -> value`, unwrapping line continuations. */
function directives(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const joined = lines.join('\n').replace(/\\\n/g, '');
  for (const line of joined.split('\n')) {
    const match = /^([A-Za-z0-9]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!;
    out.set(key, [...(out.get(key) ?? []), match[2]!]);
  }
  return out;
}

const parsed = sections(RAW);

describe('systemd unit: structure', () => {
  it('has the sections systemd needs', () => {
    expect(parsed.has('Unit')).toBe(true);
    expect(parsed.has('Service')).toBe(true);
    expect(parsed.has('Install')).toBe(true);
  });

  it('puts the start-limit bound in [Unit], where systemd reads it', () => {
    const unit = directives(parsed.get('Unit')!);
    const service = directives(parsed.get('Service')!);

    expect(unit.get('StartLimitIntervalSec')).toEqual(['300']);
    expect(unit.get('StartLimitBurst')).toEqual(['10']);
    // The mistake this guards against: present, but in the wrong section.
    expect(service.has('StartLimitIntervalSec')).toBe(false);
    expect(service.has('StartLimitBurst')).toBe(false);
    // Exactly once, so a stray duplicate cannot shadow the intended value.
    expect(RAW.match(/^StartLimitIntervalSec=/gm)?.length).toBe(1);
    expect(RAW.match(/^StartLimitBurst=/gm)?.length).toBe(1);
  });
});

describe('systemd unit: the service it starts', () => {
  const service = directives(parsed.get('Service')!);

  it('runs the pinned Node binary against the built entrypoint', () => {
    const exec = service.get('ExecStart')?.[0] ?? '';
    expect(exec.startsWith('/usr/bin/node ')).toBe(true);
    expect(exec).toContain('/opt/flop-close-call/current/dist/main.mjs');
    // Not a shell wrapper, not a process manager.
    expect(exec).not.toContain('pm2');
    expect(exec).not.toContain('/bin/sh');
  });

  it('loads the environment from outside the release tree', () => {
    expect(service.get('EnvironmentFile')).toEqual(['/opt/flop-close-call/shared/flop.env']);
  });

  it('runs as the dedicated flop user, never root', () => {
    expect(service.get('User')).toEqual(['flop']);
    expect(service.get('Group')).toEqual(['flop']);
  });

  it('restarts on failure with SIGTERM as the stop signal', () => {
    expect(service.get('Restart')).toEqual(['always']);
    expect(service.get('KillSignal')).toEqual(['SIGTERM']);
    expect(service.has('RestartSec')).toBe(true);
  });

  it('keeps the state tree writable and the release tree read-only', () => {
    const rw = service.get('ReadWritePaths')?.[0] ?? '';
    expect(rw).toContain('/opt/flop-close-call/shared');
    expect(rw).toContain('/opt/flop-close-call/secrets');
    expect(rw).not.toContain('/opt/flop-close-call/current');
  });

  it('does not use a key name that systemd only accepts in [Unit]', () => {
    // A small, explicit list: these are the ones this unit has historically been
    // tempted to carry, and putting any of them under [Service] is the exact
    // "Unknown key name" the review called out.
    const unitOnly = [
      'StartLimitIntervalSec',
      'StartLimitBurst',
      'StartLimitAction',
      'After',
      'Wants',
      'Requires',
      'Description',
      'Documentation',
    ];
    for (const key of unitOnly) {
      expect(service.has(key), `${key} must not appear in [Service]`).toBe(false);
    }
  });
});
