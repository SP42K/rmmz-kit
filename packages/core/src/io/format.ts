/**
 * MZ's editor has no published JSON serialization spec (verified: no public
 * documentation confirms the exact byte format — see docs/rmmz-automation-implementation-plan.md
 * risk R1). Working assumption, isolated here per R1's mitigation so a future
 * correction against real editor output touches one file: MZ writes fully
 * minified JSON (`JSON.stringify(data)`, no indentation, no spaces, single line).
 *
 * If this assumption is later proven wrong against a real saved project,
 * only this module needs to change.
 */
export function stringifyCompact(data: unknown): string {
  return JSON.stringify(data);
}

export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}
