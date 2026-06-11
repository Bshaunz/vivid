import type { DataLayer } from "./DataLayer";
import { LocalStorageDataLayer } from "./localStorageDataLayer";

export type { DataLayer };

/**
 * The single place the backing store is chosen. When the FastAPI/Supabase
 * implementation lands, it gets selected here (e.g. by env flag) and nothing
 * else in the app changes.
 */
export function createDataLayer(): DataLayer {
  return new LocalStorageDataLayer();
}
