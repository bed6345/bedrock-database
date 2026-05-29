/**
 * Connection settings for the shared backend (backend/server.js).
 *
 * These values are bundled into the script, so every BDS instance must use the
 * same URL/token to share data. Point BACKEND_URL at wherever you run the
 * backend process; if it runs on the same machine as the servers, the loopback
 * address below is correct.
 *
 * IMPORTANT: change API_TOKEN to a secret value and start the backend with a
 * matching DB_TOKEN environment variable.
 */
export const BACKEND_URL = "http://127.0.0.1:8080";
export const API_TOKEN = "change-me-please";

/**
 * How often (in ticks, 20 = 1 second) each online player's profile is saved
 * to the backend. Because a player's inventory cannot be read after they
 * leave, the most recent autosave is what transfers to the next server.
 */
export const AUTOSAVE_INTERVAL_TICKS = 100;
