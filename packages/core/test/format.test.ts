import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, stringifyCompact } from '../src/io/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MAP = path.resolve(__dirname, '../../../fixtures/minimal-project/data/Map001.json');

describe('format', () => {
  it('stringifyCompact produces no whitespace', () => {
    const text = stringifyCompact({ a: 1, b: [1, 2, 3], c: { d: 'e' } });
    expect(text).toBe('{"a":1,"b":[1,2,3],"c":{"d":"e"}}');
    expect(text).not.toContain('\n');
    expect(text).not.toContain('  ');
  });

  it('round-trips parse -> stringify -> parse to an identical object (golden fixture)', async () => {
    const original = parseJson(await readFile(FIXTURE_MAP, 'utf-8'));
    const roundTripped = parseJson(stringifyCompact(original));
    expect(roundTripped).toEqual(original);
  });

  it('is deterministic: same object always serializes to the same bytes', () => {
    const data = { z: 1, a: 2, nested: { y: [1, 2], x: null } };
    expect(stringifyCompact(data)).toBe(stringifyCompact(data));
  });
});
