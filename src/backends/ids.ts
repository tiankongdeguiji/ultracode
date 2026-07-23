/** Implemented worker backend identifiers shared by config and run admission. */

export const IMPLEMENTED_BACKEND_IDS = ['mock', 'codex', 'qoder', 'claude', 'gemini'] as const;

export type ImplementedBackendId = (typeof IMPLEMENTED_BACKEND_IDS)[number];

export const IMPLEMENTED_BACKENDS: ReadonlySet<string> = new Set(IMPLEMENTED_BACKEND_IDS);
