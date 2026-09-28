/**
 * PM2 process definition: exactly one app, one instance, fork mode.
 *
 * The whole design is a single Node.js process managing 150 logical agents, so
 * there is deliberately no cluster here: `instances: 1` and `exec_mode: fork`.
 * A cluster would create N processes with N reader cursors, N writer queues and
 * N copies of the same in-memory key store — which is the failure mode the
 * project exists to avoid.
 *
 * The memory ceiling is enforced twice: `max_memory_restart` restarts the
 * process if it ever exceeds 650 MB, and NODE_OPTIONS caps the V8 old space at
 * 512 MB — 138 MB below the restart line — so ordinary heap growth is a GC pause
 * rather than a restart.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs flop-close-call
 *   pm2 reload flop-close-call        # zero-downtime, after a human-approved release
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
      autorestart: true,
      // Give the reader a full sweep to finish an in-flight write before SIGKILL.
      kill_timeout: 20_000,
      listen_timeout: 15_000,
      max_memory_restart: '650M',
      // A crash loop must not become a fork bomb on a shared box.
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 5_000,
      exp_backoff_restart_delay: 1_000,
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
      // Rotated by size rather than by time: this process can be quiet for hours
      // and then busy across a sweep boundary. These keys take effect when the
      // pm2-logrotate module is installed.
      max_size: '10M',
      retain: 5,
    },
  ],
};
