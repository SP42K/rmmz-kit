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
};
