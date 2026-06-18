// Durable storage for per-guild volume preferences.
//
// Fly destroys the machine when scaled to zero (every night), so the bot's
// local disk is wiped and an in-memory Map alone can't survive. We persist to
// a free-tier Upstash Redis over its HTTPS REST API instead.
//
// Persistence is OPTIONAL: when the two UPSTASH_* env vars are unset (local
// dev, tests, or any unconfigured deploy) the store is a no-op and the bot
// keeps its previous in-memory-only behaviour. All network failures are logged
// and swallowed — a flaky Redis must never break the `!volume` command or boot.

const Sentry = require("@sentry/node");
const debug = require("debug")("volumeStore");

const DEFAULT_HASH_KEY = "manibot:volumes";

// Cap each request so a connection that opens but never responds can't stall
// startup (hydrate runs before login). TimeoutError is caught like any failure.
const REQUEST_TIMEOUT_MS = 5_000;

// Env is read on each call (not cached at module load) so tests can toggle
// configuration without juggling module resets.
const getConfig = () => ({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  key: process.env.MANIBOT_VOLUME_KEY || DEFAULT_HASH_KEY,
});

const isEnabled = () => {
  const { url, token } = getConfig();
  return Boolean(url && token);
};

// Run a single Redis command via the Upstash REST API. The base URL receives a
// POST whose body is a JSON array: [command, ...args]. Success → { result },
// failure → { error }.
const runCommand = async (command) => {
  const { url, token } = getConfig();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Upstash request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload && payload.error) {
    throw new Error(`Upstash error: ${payload.error}`);
  }

  return payload ? payload.result : undefined;
};

// HGETALL returns a flat [field, value, field, value, ...] array over the REST
// API. Some clients hand back a plain object instead, so tolerate both. Only
// finite numbers survive; clamping to the valid range is left to the caller.
const parseHash = (result) => {
  const preferences = new Map();

  if (Array.isArray(result)) {
    for (let i = 0; i + 1 < result.length; i += 2) {
      const guildId = String(result[i]);
      const volume = Number(result[i + 1]);
      if (Number.isFinite(volume)) {
        preferences.set(guildId, volume);
      }
    }
    return preferences;
  }

  if (result && typeof result === "object") {
    for (const [guildId, raw] of Object.entries(result)) {
      const volume = Number(raw);
      if (Number.isFinite(volume)) {
        preferences.set(String(guildId), volume);
      }
    }
  }

  return preferences;
};

// Load every stored guild preference. Returns an empty Map when persistence is
// disabled or the backend is unreachable, so callers always get a usable value.
const load = async () => {
  if (!isEnabled()) {
    return new Map();
  }

  try {
    const { key } = getConfig();
    const result = await runCommand(["HGETALL", key]);
    const preferences = parseHash(result);
    debug("loaded %d guild volume preference(s)", preferences.size);
    return preferences;
  } catch (error) {
    debug("failed to load volume preferences", error);
    Sentry.captureException(error);
    return new Map();
  }
};

// Persist a single guild's preference. Fire-and-forget friendly: resolves even
// on failure (logged + reported) so the in-memory update is never blocked.
const save = async (guildId, volume) => {
  if (!isEnabled()) {
    return;
  }

  try {
    const { key } = getConfig();
    await runCommand(["HSET", key, String(guildId), String(volume)]);
    debug("saved volume preference for guild %s", guildId);
  } catch (error) {
    debug("failed to save volume preference for guild %s", guildId, error);
    Sentry.captureException(error);
  }
};

module.exports = {
  isEnabled,
  load,
  save,
};
