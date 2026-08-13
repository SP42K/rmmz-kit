export { compile, buildMoveRoute } from './emit.js';
export { decompile } from './decompile.js';
export { parseDsl, moveStep } from './dsl/parse.js';
export type { DslNameResolver } from './dsl/parse.js';
export { printDsl } from './dsl/print.js';
export type { DslNameLookup } from './dsl/print.js';
export * from './ir.js';
export type { Step, MoveStepSpec } from './dsl/schema.js';
