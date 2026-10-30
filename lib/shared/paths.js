/** Filesystem locations shared by the Host bridge and the terminal client. */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the DSH data directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  const home = env.DSH_HOME?.trim();
  return home === undefined || home === '' ? join(homedir(), '.dsh') : home;
}
