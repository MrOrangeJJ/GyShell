/**
 * The SSH shell emits this control sequence once after its runtime becomes
 * usable. Restored terminals consume it before it reaches durable history.
 */
export const SSH_INITIALIZATION_CLEAR_SEQUENCE = '\x1b[2J\x1b[H'
