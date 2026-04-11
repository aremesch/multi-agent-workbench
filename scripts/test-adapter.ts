/**
 * Replay a captured terminal session against an adapter config and print
 * fired events in order. Useful for tuning patterns against real CLI output
 * before a config goes live.
 *
 *   pnpm test:adapter cli-adapters/claude-code.jsonc session.txt
 */

import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { adapterConfigSchema } from '../src/lib/server/agents/adapters/adapter.config.schema.js';
import { ConfigDrivenAdapter } from '../src/lib/server/agents/adapters/ConfigDrivenAdapter.js';

const [configPath, recordingPath] = process.argv.slice(2);
if (!configPath || !recordingPath) {
  console.error('usage: pnpm test:adapter <adapter.jsonc> <recording>');
  process.exit(2);
}

const errors: import('jsonc-parser').ParseError[] = [];
const raw: unknown = parseJsonc(readFileSync(configPath, 'utf8'), errors, {
  allowTrailingComma: true
});
if (errors.length > 0) {
  console.error('JSONC parse errors:', errors);
  process.exit(1);
}
const cfg = adapterConfigSchema.parse(raw);
const adapter = new ConfigDrivenAdapter(cfg);

const bytes = readFileSync(recordingPath);
// Feed in 256-byte chunks to simulate realistic streaming.
let offset = 0;
let totalEvents = 0;
while (offset < bytes.length) {
  const chunk = bytes.subarray(offset, offset + 256);
  offset += 256;
  for (const ev of adapter.ingest(chunk)) {
    totalEvents++;
    console.log(
      `[${ev.at}] ${ev.kind.padEnd(16)} patternId=${ev.patternId ?? '-'} detail=${JSON.stringify(ev.detail ?? {})}`
    );
  }
}
console.log(`--- ${totalEvents} events fired; final state=${adapter.state()} ---`);
