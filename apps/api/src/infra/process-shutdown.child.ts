import { installProcessShutdownHandlers } from './process-shutdown.js';

const healthy = process.argv[2] === 'healthy';
// A real stuck Nest hook coexists with the HTTP server/socket handles. Keep one
// equivalent active handle so the unref'd watchdog is what terminates this child.
if (!healthy) setInterval(() => undefined, 60_000);

installProcessShutdownHandlers({
  close: () => (healthy ? Promise.resolve() : new Promise<void>(() => undefined)),
  fatal: (message) => process.stderr.write(`${message}\n`),
});

process.kill(process.pid, 'SIGTERM');
