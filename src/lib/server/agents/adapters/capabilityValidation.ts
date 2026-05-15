/**
 * Helpers for validating user-supplied capability values (e.g. role's
 * `default_model`, spawn form's `model`) against an adapter's declared
 * `capabilities.*.values` list.
 *
 * Keeping this server-side so unknown ids — including ones that point at
 * a value the adapter used to expose but no longer does after a JSONC
 * edit — fall back to null cleanly. We never propagate a foreign value
 * into the agent row or into argv substitution.
 */

import type { AdapterCapabilityListing } from './AdapterRegistry.js';

/**
 * Coerce a JSON-supplied value into the capability's allowed ids, or null.
 *
 * Returns `null` when:
 *   - the capability isn't defined on this adapter (covers the case where a
 *     role is associated with a cli_kind whose adapter has no `model` /
 *     `permissionMode` selector);
 *   - the input is null, undefined, an empty string, or anything but a string;
 *   - the input is a string but doesn't match any id in `capability.values`.
 *
 * Otherwise returns the validated id verbatim. The caller stores this in
 * `roles.default_*` or `agents.*` columns.
 */
export function sanitizeCapabilityValue(
  capability: AdapterCapabilityListing | null,
  raw: unknown
): string | null {
  if (!capability) return null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const allowed = capability.values.find((v) => v.id === trimmed);
  return allowed ? allowed.id : null;
}
