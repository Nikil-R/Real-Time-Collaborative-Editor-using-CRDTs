import type { DocSession } from "@rce/client";

/**
 * The live sync session of the open document. Kept outside React state because
 * it is a long-lived object with its own timers, not something to re-render on.
 */
export const sessionRef: { current: DocSession | null } = { current: null };
