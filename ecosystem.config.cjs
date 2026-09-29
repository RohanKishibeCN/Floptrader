/**
 * PM2 process definition — a development tool, NOT the VPS supervisor.
 *
 * On the VPS, systemd owns this process: one unit, one cgroup, one restart
 * policy, and `CPUQuota`/`MemoryMax` enforced by the kernel. See
 * `systemd/flop-close-call.service`. Do not run PM2 on the VPS alongside it:
 * two supervisors configured to restart the same program will fight, and half
 * the restarts will land outside the cgroup that is supposed to bound them.
 *
 * What this file is for: running the built process on a workstation with log
 * collection, e.g. `pm2 start ecosystem.config.cjs && pm2 logs flop-close-call`.
 * `autorestart` is deliberately false so this can never become a second
 * supervisor by accident; memory ceilings are systemd's job, not a config file's.
 *
 * The shape is still one process: `instances: 1`, `exec_mode: 'fork'`. The whole
 * design is a single Node.js process managing 150 logical agents, so a cluster
 * would mean N reader cursors, N writer queues and N copies of the same
 * in-memory key store — the failure mode this project exists to avoid.
 */
const path = require('node:path');

const root = __dirname;

module.exports = {
  apps: [
    {
      name: 'flop-close-call',
      script: path.join(root, 'dist/main.mjs'),
      cwd: root,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: false,
      // Give the reader time to finish an in-flight write before SIGKILL.
      kill_timeout: 20_000,
      listen_timeout: 15_000,
      // The process reads .env itself through its zod-validated config, so PM2
      // must not invent values. Only the heap cap is set here.
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--max-old-space-size=512',
      },
      out_file: path.join(root, 'logs/out.log'),
      error_file: path.join(root, 'logs/error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
