// Upstash Redis over its HTTPS REST API (no extra npm dependency).
//
// Optional: with the two UPSTASH_* env vars unset (local dev, tests, or any
// unconfigured deploy) callers keep their state in memory only.

// Cap each request so a connection that opens but never responds can't stall
// startup (hydrate runs before login). TimeoutError is caught like any failure.
const REQUEST_TIMEOUT_MS = 5_000;

// Env is read on each call (not cached at module load) so tests can toggle
// configuration without juggling module resets.
const isEnabled = () =>
  Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );

// Run a single Redis command. The base URL receives a POST whose body is a
// JSON array: [command, ...args]. Success → { result }, failure → { error }.
const runCommand = async (command) => {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
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

module.exports = { isEnabled, runCommand };
