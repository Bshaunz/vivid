import type { DataLayer } from "./DataLayer";
import { ApiDataLayer } from "./apiDataLayer";

export type { DataLayer };

/**
 * The single place the backing store is chosen. The app is now API-first: the
 * live FastAPI backend is the system of record (base URL resolved in lib/http).
 * LocalStorageDataLayer remains in the repo for the offline-data smoke test but
 * is no longer a runtime source.
 */
export function createDataLayer(): DataLayer {
  return new ApiDataLayer();
}
