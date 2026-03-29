const { execFile } = require("child_process");
const debug = require("debug")("ytDlpScheduler");

const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const UPDATE_TIMEOUT_MS = 180_000;

const parseIntervalHours = () => {
  const raw = process.env.YTDLP_SCHEDULED_UPDATE_HOURS;
  if (raw === undefined || raw === "") {
    return 24;
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  return n;
};

let updateInFlight = false;

const runYtDlpSelfUpdate = () => {
  if (updateInFlight) {
    return;
  }

  updateInFlight = true;
  execFile(
    YTDLP_BIN,
    ["-U"],
    { timeout: UPDATE_TIMEOUT_MS, windowsHide: true },
    (error, stdout, stderr) => {
      updateInFlight = false;

      const text = `${stdout || ""}${stderr || ""}`.trim();
      if (text) {
        debug(text);
      }

      if (error) {
        if (error.code === "ENOENT") {
          debug("yt-dlp binary not found at %s; skip scheduled update", YTDLP_BIN);
          return;
        }

        debug("yt-dlp -U failed: %s", error.message || error);
      }
    },
  );
};

const startYtDlpScheduledUpdates = () => {
  const hours = parseIntervalHours();
  if (hours === null) {
    debug("scheduled yt-dlp updates disabled (YTDLP_SCHEDULED_UPDATE_HOURS<=0)");
    return;
  }

  const ms = hours * 3600 * 1000;
  debug("scheduling yt-dlp self-update every %s hours", hours);
  setInterval(runYtDlpSelfUpdate, ms);
};

module.exports = { startYtDlpScheduledUpdates };
