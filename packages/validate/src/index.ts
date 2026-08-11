import type { ProjectSession } from '@rmmz-kit/core';
import type { Finding } from './types.js';
import { checkStructure } from './rules/structure.js';
import { checkReferences } from './rules/references.js';
import { checkSemantics } from './rules/semantics.js';

export type { Finding, Severity } from './types.js';

/**
 * L4 validator (plan §3 M4). Runs independently of ProjectSession.validate()
 * — that method only guards commit() (drift + JSON-serializability); this is
 * the semantic/reference/structure pass an agent runs before committing, or
 * a human runs against an arbitrary project.
 */
export async function validateProject(session: ProjectSession): Promise<Finding[]> {
  return [...checkStructure(session), ...(await checkReferences(session)), ...checkSemantics(session)];
}
