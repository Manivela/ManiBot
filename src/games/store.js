// Per-guild game state, in one Redis hash per guild (kept in memory after the
// first read; memory only without Upstash). Fields:
//   config              {"botChannelId", "extraRoleIds"}
//   game:<appId>        {"status": "proposed"|"linked"|"ignored", "name",
//                        "roleId", "ingameRoleId", "channelId", "proposal"}
//   players:<appId>     {"<userId>": lastSeenMs}, only for games not set up yet
//   optout:<userId>:<roleId>   "1": took that game role off in the picker
// Games are keyed by Discord's application ID, so a role or game can be
// renamed without breaking the link.

const Sentry = require("@sentry/node");
const debug = require("debug")("games:store");
const upstash = require("../utils/upstash");

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAYER_WINDOW_MS = 30 * DAY_MS;
const RETRY_LOAD_MS = 60_000;

const keyFor = (guildId) => `manibot:guild:${guildId}`;

// HGETALL comes back as a flat [field, value, ...] array over REST.
const hashEntries = (result) => {
  if (!Array.isArray(result)) {
    return Object.entries(result || {});
  }
  const entries = [];
  for (let i = 0; i + 1 < result.length; i += 2) {
    entries.push([String(result[i]), String(result[i + 1])]);
  }
  return entries;
};

const parse = (entries) => {
  const state = {
    config: {},
    games: new Map(),
    players: new Map(),
    optouts: new Set(),
  };
  for (const [field, raw] of entries) {
    const [kind, ...rest] = field.split(":");
    const id = rest.join(":");
    try {
      if (kind === "config") {
        state.config = JSON.parse(raw);
      } else if (kind === "game") {
        state.games.set(id, JSON.parse(raw));
      } else if (kind === "players") {
        state.players.set(id, JSON.parse(raw));
      } else if (kind === "optout") {
        state.optouts.add(id);
      }
    } catch (error) {
      debug("skipping unreadable field %s", field, error);
    }
  }
  return state;
};

// Writes go out one at a time, in order, without blocking the caller; memory
// is what the bot reads, Redis is what the next start reads.
let writes = Promise.resolve();
const persist = (guildId, [command, ...args]) => {
  if (!upstash.isEnabled()) {
    return;
  }
  writes = writes
    .then(() => upstash.runCommand([command, keyFor(guildId), ...args]))
    .catch((error) => {
      debug("failed to save game state for guild %s", guildId, error);
      Sentry.captureException(error);
    });
};

const recentPlayers = (players, now) =>
  Object.fromEntries(
    Object.entries(players).filter(([, at]) => now - at < PLAYER_WINDOW_MS),
  );

const load = async (guildId) => {
  if (!upstash.isEnabled()) {
    return parse([]);
  }
  const state = parse(
    hashEntries(await upstash.runCommand(["HGETALL", keyFor(guildId)])),
  );
  // Play history older than the window isn't needed; don't keep it.
  const now = Date.now();
  for (const [appId, players] of state.players) {
    const recent = recentPlayers(players, now);
    if (Object.keys(recent).length === Object.keys(players).length) {
      continue;
    }
    if (Object.keys(recent).length) {
      state.players.set(appId, recent);
      persist(guildId, ["HSET", `players:${appId}`, JSON.stringify(recent)]);
    } else {
      state.players.delete(appId);
      persist(guildId, ["HDEL", `players:${appId}`]);
    }
  }
  debug("loaded %d game(s) for guild %s", state.games.size, guildId);
  return state;
};

const states = new Map();

// Fails closed: while a guild's state can't be read this rejects, so nothing
// gets proposed or handed out from what would look like an empty list. The
// read is retried a minute later.
const getGuildState = (guildId) => {
  if (!states.has(guildId)) {
    states.set(
      guildId,
      load(guildId).catch((error) => {
        debug("failed to load game state for guild %s", guildId, error);
        Sentry.captureException(error);
        setTimeout(() => states.delete(guildId), RETRY_LOAD_MS).unref?.();
        throw error;
      }),
    );
  }
  return states.get(guildId);
};

// Setting a game up (or ignoring it) also drops who played it.
const setGame = (guildId, state, appId, game) => {
  state.games.set(appId, game);
  persist(guildId, ["HSET", `game:${appId}`, JSON.stringify(game)]);
  if (state.players.delete(appId)) {
    persist(guildId, ["HDEL", `players:${appId}`]);
  }
};

// Returns how many different members played the game within the window.
const addPlayer = (guildId, state, appId, userId, now = Date.now()) => {
  const before = state.players.get(appId) || {};
  const players = recentPlayers(before, now);
  // At most one write per member and game a day: presence updates are frequent.
  if (!(now - (players[userId] || 0) < DAY_MS)) {
    players[userId] = now;
  }
  const count = Object.keys(players).length;
  if (
    count !== Object.keys(before).length ||
    players[userId] !== before[userId]
  ) {
    state.players.set(appId, players);
    persist(guildId, ["HSET", `players:${appId}`, JSON.stringify(players)]);
  }
  return count;
};

const isOptedOut = (state, userId, roleId) =>
  state.optouts.has(`${userId}:${roleId}`);

const setOptOut = (guildId, state, userId, roleId, optedOut) => {
  const field = `${userId}:${roleId}`;
  if (state.optouts.has(field) === optedOut) {
    return;
  }
  if (optedOut) {
    state.optouts.add(field);
    persist(guildId, ["HSET", `optout:${field}`, "1"]);
  } else {
    state.optouts.delete(field);
    persist(guildId, ["HDEL", `optout:${field}`]);
  }
};

const setConfig = (guildId, state, changes) => {
  state.config = { ...state.config, ...changes };
  persist(guildId, ["HSET", "config", JSON.stringify(state.config)]);
};

// Resolves once every write so far has been attempted (tests, scripts).
const flush = () => writes;

module.exports = {
  addPlayer,
  flush,
  getGuildState,
  isOptedOut,
  setConfig,
  setGame,
  setOptOut,
};
