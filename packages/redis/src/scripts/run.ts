// packages/redis/src/scripts/run.ts
//
// EVALSHA with a NOSCRIPT -> EVAL fallback, frozen per .claude/contracts/phase-1.md §4.8.
//
// Why this exists at all: `SCRIPT FLUSH`, a Redis restart without AOF script-cache
// persistence, a failover to a replica that never saw the script, or
// `redis-cli DEBUG RELOAD` all empty the server's script cache. Without this fallback,
// every purchase after that returns NOSCRIPT — a total outage of the hot path from an
// operation that is supposed to be harmless.
//
// Deliberately NOT `ioredis`'s `defineCommand`: that attaches dynamically-named methods
// the type system cannot see (the hot path would lose type safety at exactly the call
// that upholds I1-I3), and it hides the EVALSHA->EVAL fallback inside the library where
// our spec cannot observe it. We are required to *prove* the fallback works — an
// explicit implementation is testable, the library's internal one is not.
import type { Redis } from 'ioredis';

import type { LuaScript } from './registry';

/** Matches the exact error Redis raises when a SHA is not present in the script cache. */
export function isNoScriptError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /NOSCRIPT/.test(message);
}

/**
 * Runs a registered Lua script via EVALSHA, falling back to EVAL exactly once if the
 * server reports NOSCRIPT (empty script cache). Any other error rethrows immediately —
 * the fallback must never mask a real failure or loop.
 */
export async function runScript<T = unknown>(
  client: Redis,
  script: LuaScript,
  keys: string[],
  args: (string | number)[],
): Promise<T> {
  if (keys.length !== script.numKeys) {
    throw new Error(
      `runScript: '${script.name}' expects ${script.numKeys} KEYS, received ${keys.length}`,
    );
  }

  const flatArgs: (string | number)[] = [...keys, ...args];

  try {
    return (await client.evalsha(script.sha1, script.numKeys, ...flatArgs)) as T;
  } catch (err) {
    if (!isNoScriptError(err)) {
      throw err;
    }
    // Fallback fires at most once: this call is not wrapped in its own try/catch, so a
    // failure here (including a second NOSCRIPT, which should be impossible) propagates
    // rather than looping.
    return (await client.eval(script.src, script.numKeys, ...flatArgs)) as T;
  }
}
