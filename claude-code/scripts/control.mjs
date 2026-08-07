#!/usr/bin/env node
/**
 * Turns the gate on and off from outside a prompt.
 *
 * The hook already intercepts the bare `tokenlens on|off|status` phrases at zero
 * cost, so this exists for the `/tokenlens` slash command and for scripting.
 *
 *   node scripts/control.mjs on|off|status
 */
import { loadConfig, setEnabled } from '../src/config.mjs';
import { formatControl } from '../src/format.mjs';

const VALID = new Set(['on', 'off', 'status']);

async function main() {
  const requested = (process.argv[2] ?? 'status').trim().toLowerCase();
  const command = VALID.has(requested) ? requested : 'status';

  let config;
  if (command === 'on') config = await setEnabled(true);
  else if (command === 'off') config = await setEnabled(false);
  else config = await loadConfig();

  process.stdout.write(`${formatControl(command, config)}\n`);
  if (!VALID.has(requested)) {
    process.stdout.write(`\nUnknown argument "${requested}". Showing status instead.\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`TokenLens control failed: ${error.message}\n`);
  process.exitCode = 1;
});
