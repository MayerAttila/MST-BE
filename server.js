const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { SerialPort } = require("serialport");

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, "readings.jsonl");
const STATS_LOG = path.join(__dirname, "uptime_stats.jsonl");
const RETENTION_DAYS = (() => {
  const parsed = Number(process.env.RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
})();
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SERIAL_PORT = process.env.SERIAL_PORT || "COM3";
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD) || 115200;

app.use(express.json());

let stats = {
  total_online_ms: 0,
  total_offline_ms: 0,
  last_status: null,
  last_timestamp: null,
};

const resetStats = () => ({
  total_online_ms: 0,
  total_offline_ms: 0,
  last_status: null,
  last_timestamp: null,
});

const appendStatsSegment = async ({
  status,
  start_at,
  end_at,
  duration_ms,
}) => {
  const entry = {
    snapshot_at: new Date().toISOString(),
    status,
    start_at,
    end_at,
    duration_ms,
    duration_hms: formatMs(duration_ms),
  };
  await fs.appendFile(STATS_LOG, JSON.stringify(entry) + "\n", "utf8");
};

const computeOnline = (reading) => {
  const p = reading.power;
  if (typeof p === "boolean") return p;
  if (typeof p === "number") return p !== 0;
  if (typeof p === "string")
    return p.trim().toLowerCase() === "on" || p.trim() === "1";
  return false;
};

const formatMs = (ms) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

const recomputeStats = (readings) => {
  const nextStats = resetStats();
  const sorted = readings.slice().sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return ta - tb;
  });

  for (const reading of sorted) {
    const tsMs = new Date(reading.timestamp).getTime();
    if (Number.isNaN(tsMs)) continue;
    const online = computeOnline(reading);

    if (nextStats.last_status !== null && nextStats.last_timestamp) {
      const lastMs = new Date(nextStats.last_timestamp).getTime();
      const delta = Math.max(0, tsMs - lastMs);
      if (nextStats.last_status) {
        nextStats.total_online_ms += delta;
      } else {
        nextStats.total_offline_ms += delta;
      }
    }

    nextStats.last_status = online;
    nextStats.last_timestamp = reading.timestamp;
  }

  return nextStats;
};

const pruneOldStatsLog = async () => {
  const cutoff = Date.now() - RETENTION_MS;
  let lines;
  try {
    const raw = await fs.readFile(STATS_LOG, "utf8");
    lines = raw.split("\n").filter(Boolean);
  } catch {
    lines = [];
  }

  const kept = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const ts = obj.snapshot_at;
      const tsMs = ts ? new Date(ts).getTime() : NaN;
      if (!Number.isNaN(tsMs) && tsMs >= cutoff) {
        kept.push(obj);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (kept.length === 0) {
    await fs.writeFile(STATS_LOG, "", "utf8");
    return;
  }

  const payload = kept.map((obj) => JSON.stringify(obj)).join("\n") + "\n";
  await fs.writeFile(STATS_LOG, payload, "utf8");
};

const pruneOldReadings = async () => {
  const now = Date.now();
  const cutoff = now - RETENTION_MS;
  let lines;
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    lines = raw.split("\n").filter(Boolean);
  } catch {
    lines = [];
  }

  const kept = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const tsMs = new Date(obj.timestamp).getTime();
      if (!Number.isNaN(tsMs) && tsMs >= cutoff) {
        kept.push(obj);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (kept.length === 0) {
    await fs.writeFile(LOG_FILE, "", "utf8");
    stats = resetStats();
    return;
  }

  const payload = kept.map((obj) => JSON.stringify(obj)).join("\n") + "\n";
  await fs.writeFile(LOG_FILE, payload, "utf8");
  stats = recomputeStats(kept);
};

const loadStatsFromReadings = async () => {
  let lines;
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    lines = raw.split("\n").filter(Boolean);
  } catch {
    lines = [];
  }

  const readings = [];
  for (const line of lines) {
    try {
      readings.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  if (readings.length === 0) {
    stats = resetStats();
    return;
  }

  stats = recomputeStats(readings);
};

const initialize = async () => {
  console.log(`Log retention set to ${RETENTION_DAYS} day(s).`);
  await pruneOldReadings();
  await pruneOldStatsLog();
  await loadStatsFromReadings();
  // prune daily
  setInterval(() => {
    pruneOldReadings().catch((err) => console.error("Prune failed:", err));
    pruneOldStatsLog().catch((err) =>
      console.error("Prune stats failed:", err)
    );
  }, 24 * 60 * 60 * 1000);
};

const appendReading = async (reading) => {
  const stamped = {
    ...reading,
    timestamp: new Date().toISOString(),
  };
  await fs.appendFile(LOG_FILE, JSON.stringify(stamped) + "\n", "utf8");

  const nowMs = new Date(stamped.timestamp).getTime();
  const online = computeOnline(stamped);

  if (stats.last_status !== null && stats.last_timestamp) {
    const lastMs = new Date(stats.last_timestamp).getTime();
    const delta = Math.max(0, nowMs - lastMs);
    if (stats.last_status) {
      stats.total_online_ms += delta;
    } else {
      stats.total_offline_ms += delta;
    }

    // On status change, log the duration of the previous state
    if (online !== stats.last_status && delta > 0) {
      await appendStatsSegment({
        status: stats.last_status ? "online" : "offline",
        start_at: stats.last_timestamp,
        end_at: stamped.timestamp,
        duration_ms: delta,
      });
    }
  }

  stats.last_status = online;
  stats.last_timestamp = stamped.timestamp;

  return stamped;
};

// Accepts JSON payloads like {"id":1,"device":"press_machine","power":0}
app.post("/readings", async (req, res) => {
  try {
    const reading = req.body || {};
    const stamped = await appendReading(reading);
    res.status(201).json({ status: "ok", saved: stamped });
  } catch (err) {
    console.error("Failed to log reading:", err);
    res.status(500).json({ error: "Failed to save reading" });
  }
});

app.get("/", (_req, res) => {
  res.send("Reading logger is running. POST JSON to /readings");
});

app.get("/stats", (_req, res) => {
  res.json({
    total_online_ms: stats.total_online_ms,
    total_online_hms: formatMs(stats.total_online_ms),
    total_offline_ms: stats.total_offline_ms,
    total_offline_hms: formatMs(stats.total_offline_ms),
    last_status: stats.last_status,
    last_timestamp: stats.last_timestamp,
  });
});

const startSerial = () => {
  let port;
  try {
    port = new SerialPort({ path: SERIAL_PORT, baudRate: SERIAL_BAUD });
  } catch (err) {
    console.error("Unable to open serial port:", err.message);
    return;
  }

  let buffer = "";

  const flushBuffer = async () => {
    while (true) {
      const start = buffer.indexOf("{");
      if (start === -1) {
        buffer = "";
        return;
      }
      if (start > 0) buffer = buffer.slice(start);

      let depth = 0;
      let end = -1;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch === "{") depth += 1;
        if (ch === "}") depth -= 1;
        if (depth === 0 && ch === "}") {
          end = i;
          break;
        }
      }
      if (end === -1) return; // wait for more data

      const candidate = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);

      console.log("Serial raw:", candidate);
      try {
        const parsed = JSON.parse(candidate);
        const saved = await appendReading(parsed);
        console.log("Saved serial reading:", saved);
      } catch (err) {
        console.warn("Serial data not JSON, skipped:", candidate, err.message);
      }
    }
  };

  port.on("data", async (chunk) => {
    buffer += chunk.toString();
    await flushBuffer();
  });

  port.on("open", () => {
    console.log(`Serial listening on ${SERIAL_PORT} @ ${SERIAL_BAUD}`);
  });

  port.on("error", (err) => {
    console.error("Serial port error:", err.message);
  });
};

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  initialize()
    .catch((err) => console.error("Failed to initialize:", err))
    .finally(() => startSerial());
});
