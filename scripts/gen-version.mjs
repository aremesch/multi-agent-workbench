/**
 * Generates version metadata from git.
 *
 * Exported for use in vite.config.ts and tests. When run directly as a
 * script it prints the three values.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** @returns {{ version: string, buildNumber: string, buildDate: string }} */
export function generateVersionInfo() {
  // ── version ────────────────────────────────────────────────────────
  let version;
  try {
    let described = execSync(
      'git describe --tags --always --dirty --abbrev=7',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    // Strip leading 'v' so output matches package.json bare-semver.
    described = described.replace(/^v/, '');

    // Bare SHA means no tags exist — anchor to package.json version.
    if (/^[0-9a-f]{7,40}(-dirty)?$/.test(described)) {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      version = `${pkg.version}-dev.${described}`;
    } else {
      version = described;
    }
  } catch {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    version = pkg.version;
  }

  // ── build number ───────────────────────────────────────────────────
  let buildNumber;
  try {
    buildNumber = execSync('git rev-list --count HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    buildNumber = '0';
  }

  // ── build date ─────────────────────────────────────────────────────
  let buildDate;
  try {
    buildDate = execSync('git log -1 --format=%cI', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    buildDate = new Date().toISOString();
  }

  return { version, buildNumber, buildDate };
}

// ── main guard ─────────────────────────────────────────────────────────
// Runs only when invoked directly: `node scripts/gen-version.mjs`
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/gen-version.mjs');
if (isMain) {
  const { version, buildNumber, buildDate } = generateVersionInfo();
  process.stdout.write(
    `version:    ${version}\nbuild:      ${buildNumber}\nbuild date: ${buildDate}\n`
  );
}
