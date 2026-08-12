import { describe, expect, it } from 'vitest';
import { checkSpec, questOrder, GameSpecSchema, type GameSpec } from '../src/spec.js';

/**
 * The spec-level gate. Everything here is about a game that *cannot* be
 * finished — the plan's「不卡關」— caught before a single file is touched.
 */

function spec(overrides: Partial<GameSpec> = {}): GameSpec {
  return {
    title: 'Test',
    areas: [{ key: 'town', name: 'Town' }],
    quests: [
      {
        key: 'herb',
        title: 'The Herb',
        giver: { area: 'town', name: 'Herbalist' },
        objective: { kind: 'fetch', area: 'town', name: 'Herb Patch', item: { name: 'Herb' } },
      },
    ],
    finale: { area: 'town', name: 'Bandit Chief', troop: { enemyId: 1 } },
    ...overrides,
  };
}

const codes = (s: GameSpec): string[] => checkSpec(s).map((i) => i.code);

describe('checkSpec', () => {
  it('passes a coherent one-area game', () => {
    expect(checkSpec(spec())).toEqual([]);
  });

  it('rejects references to areas and quests that do not exist', () => {
    const issues = checkSpec(
      spec({
        quests: [
          {
            key: 'herb',
            title: 'The Herb',
            giver: { area: 'nowhere', name: 'Herbalist' },
            objective: { kind: 'talk', area: 'town', name: 'Sage' },
            requires: ['ghost'],
          },
        ],
      })
    );
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['unknown-area', 'quests[0].giver.area'],
      ['unknown-quest', 'quests[0].requires[0]'],
    ]);
  });

  it('catches a requirement cycle — neither quest could ever be offered', () => {
    const issues = checkSpec(
      spec({
        quests: [
          { key: 'a', title: 'A', giver: { area: 'town', name: 'A' }, objective: { kind: 'talk', area: 'town', name: 'x' }, requires: ['b'] },
          { key: 'b', title: 'B', giver: { area: 'town', name: 'B' }, objective: { kind: 'talk', area: 'town', name: 'y' }, requires: ['a'] },
        ],
        finale: { area: 'town', name: 'Boss', troop: 1 },
      })
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('requirement-cycle');
    expect(issues[0].message).toMatch(/a -> b -> a|b -> a -> b/);
  });

  it('catches an area nothing links to, since everything in it is unreachable', () => {
    expect(
      codes(
        spec({
          areas: [
            { key: 'town', name: 'Town' },
            { key: 'cave', name: 'Cave' },
          ],
        })
      )
    ).toEqual(['unreachable-area']);
  });

  it('treats a portal pair as two-way, so declaring the link once is enough', () => {
    expect(
      checkSpec(
        spec({
          areas: [
            { key: 'town', name: 'Town' },
            { key: 'cave', name: 'Cave', connects: ['town'] },
          ],
        })
      )
    ).toEqual([]);
  });

  it('rejects duplicate keys and self-references', () => {
    expect(
      codes(
        spec({
          areas: [
            { key: 'town', name: 'Town', connects: ['town'] },
            { key: 'town', name: 'Town Again' },
          ],
        })
      )
    ).toEqual(['duplicate-area', 'self-connection']);
  });
});

describe('questOrder', () => {
  it('puts every prerequisite before the quest that needs it', () => {
    const quests = spec({
      quests: [
        { key: 'c', title: 'C', giver: { area: 'town', name: 'C' }, objective: { kind: 'talk', area: 'town', name: 'c' }, requires: ['b'] },
        { key: 'a', title: 'A', giver: { area: 'town', name: 'A' }, objective: { kind: 'talk', area: 'town', name: 'a' } },
        { key: 'b', title: 'B', giver: { area: 'town', name: 'B' }, objective: { kind: 'talk', area: 'town', name: 'b' }, requires: ['a'] },
      ],
    }).quests;
    expect(questOrder(quests)).toEqual(['a', 'b', 'c']);
  });
});

describe('GameSpecSchema', () => {
  it('accepts the example spec', () => {
    expect(GameSpecSchema.safeParse(spec()).success).toBe(true);
  });

  it('rejects a mistyped key rather than dropping the value', () => {
    // Strict all the way down, for the same reason the DSL schema is: this is a
    // surface an LLM writes, and a silently ignored `requiers:` is a quest chain
    // with no gate at all.
    const bad = { ...spec(), quests: [{ ...spec().quests[0], requiers: ['x'] }] };
    expect(GameSpecSchema.safeParse(bad).success).toBe(false);
  });
});
