import { AsyncLocalStorage } from "node:async_hooks";
export const requestContext = new AsyncLocalStorage();
// Reads repeated while one read-only answer is built (the workspace): every
// module asks for all documents, and each is worked out once, not once per
// module. Scoped to that request only; a write in it clears what was kept.
export const readCache = new AsyncLocalStorage();
