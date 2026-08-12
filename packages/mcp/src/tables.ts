/**
 * Database table name (as an LLM would say it) -> data file. Deliberately just
 * the flat array-of-entries files (plan §4.5 `upsert_database`) — Map*.json
 * isn't here because its shape (nested events/pages, not a flat id-indexed
 * array) needs `upsert_map_event` + `apply_script` instead.
 */
export const DATABASE_TABLES: Record<string, string> = {
  actors: 'Actors.json',
  classes: 'Classes.json',
  skills: 'Skills.json',
  items: 'Items.json',
  weapons: 'Weapons.json',
  armors: 'Armors.json',
  enemies: 'Enemies.json',
  states: 'States.json',
  troops: 'Troops.json',
  commonEvents: 'CommonEvents.json',
  // M6.5: also flat id-indexed arrays, so they need no new tool — only this
  // line. System.json is the one database file that isn't (single object),
  // which is what update_system exists for.
  tilesets: 'Tilesets.json',
  animations: 'Animations.json',
  mapInfos: 'MapInfos.json',
};

/**
 * Fields a *new* row of a table must have that a shallow merge onto `{}` can't
 * be expected to supply. Deliberately near-empty: per-table schemas are the
 * upfront modeling §4.5 says not to build, and every entry here has to earn its
 * place by naming a crash.
 *
 * Tilesets is the one that has (M6.5 review gap #1, scheduled to M7): MZ's
 * `Game_Map.checkPassage` indexes `tileset().flags[tileId]` for tile ids up to
 * 8191, so a row appended as `{name, id}` crashes the game on the player's
 * first step. `tilesetNames` is here for the same reason one step earlier — the
 * editor can't open a tileset whose nine sheet names are missing.
 */
export const NEW_ROW_DEFAULTS: Record<string, () => Record<string, unknown>> = {
  'Tilesets.json': () => ({
    name: '',
    mode: 1,
    tilesetNames: ['', '', '', '', '', '', '', '', ''],
    flags: new Array<number>(8192).fill(0),
    note: '',
  }),
};
