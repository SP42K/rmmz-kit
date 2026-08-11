export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  /** Stable machine id, e.g. "references/dangling-item". Group/filter by this. */
  rule: string;
  severity: Severity;
  message: string;
  file: string;
  path?: string;
}
