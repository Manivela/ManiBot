// Loaded before anything else so Sentry can instrument the modules that follow.
require("dotenv").config();
const Sentry = require("@sentry/node");
const createDebug = require("debug");

Sentry.init({
  dsn:
    process.env.NODE_ENV === "production" ? process.env.SENTRY_DSN : undefined,
  release: process.env.GIT_SHA || undefined,
  tracesSampleRate: 1,
  integrations: [
    Sentry.consoleLoggingIntegration({
      levels: ["log", "info", "warn", "error"],
    }),
    Sentry.nodeRuntimeMetricsIntegration({ collectionIntervalMs: 60_000 }),
  ],
});

// Print `debug` output by default, minus the per-member voice/presence ones,
// and send it through console so it reaches Sentry Logs.
if (process.env.DEBUG === undefined) {
  createDebug.enable("*,-voiceGateway,-presenceUpdate,-utils:role");
}
createDebug.inspectOpts.hideDate = true;
createDebug.log = (...args) => console.info(...args);
