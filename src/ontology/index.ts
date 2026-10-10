// Public surface of the store for the app. Node code (tests, pipeline) imports node.ts directly instead: this
// file pulls in the worker client, which only exists in a browser.
export * from './types.ts';
export { createStore } from './client.ts';
export type { CreateStoreOptions } from './client.ts';
export { validateBatch } from './validate.ts';
export { SCHEMA_DOC, SCHEMA_VERSION } from './schema.ts';
