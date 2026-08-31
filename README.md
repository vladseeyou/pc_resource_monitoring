# PC Resource Monitoring

A lightweight dashboard that collects CPU, RAM, GPU and temperature metrics from the
local machine **and** any other hosts on your LAN, then exposes them both as a live
web UI and in Prometheus text format for scraping.

The server samples local metrics every second, periodically scrapes each configured
remote host's `/api/metrics` endpoint over HTTP, and aggregates everything into a single
view. No external database or message broker — just Node.js built-ins.

## Endpoints

| Method | Path            | Description                                                                 |
| ------ | --------------- | --------------------------------------------------------------------------- |
| GET    | `/`             | The web dashboard (served only when `SERVE_FRONTEND` is not `false`).       |
| GET    | `/metrics`      | Local + all remote hosts in Prometheus text exposition format 0.0.4.        |
| GET    | `/api/metrics`  | Aggregated metrics as JSON: `{ timestamp, local, hosts[] }`.                |
| GET    | `/health`       | Lightweight health check with uptime and a summary of every remote host.    |

Every sample carries an `instance` label (`host:port`) so a single scrape can tell the
hosts apart. The `/metrics` output is cached within a refresh window to keep scrapes cheap.

### `/api/metrics` response shape

```json
{
  "timestamp": "2025-01-01T00:00:00.000Z",
  "local": {
    "timestamp": "...",
    "cpu":    { "usagePercent": 12.3, "cores": 8, "loadAvg": [0.2, 0.3, 0.4], "perCoreUsagePercent": [...] },
    "memory": { "totalMB": 16384, "usedMB": 9000, "freeMB": 7384, "percentUsed": 54.9 },
    "gpu":    [ { "index": 0, "name": "RTX 4090", "usagePercent": 5, "memUsedMB": 1200, "memTotalMB": 24576, "temperatureC": 41 } ],
    "temperatures": { "cpuCelsius": null, "gpuCelsius": 41, "availability": true, "gpuAvailability": true },
    "platform": "linux",
    "hostname": "this-host"
  },
  "hosts": [
    {
      "instance": "192.168.1.20:3000",
      "url": "http://192.168.1.20:3000",
      "status": "ok",
      "lastSuccessAt": "2025-01-01T00:00:02.000Z",
      "error": null,
      "data": { /* same shape as `local` above */ }
    }
  ]
}
```

Remote hosts in an error/timeout state report `"status": "error"`, a `null` `data` payload,
and the failure reason in `error`. The UI shows these as `ERR` chips with the last success
time instead of crashing.

## Configuring the list of LAN hosts to poll

The dashboard has no settings page — the fleet of remote hosts is configured entirely by the
server through the **`REMOTE_HOSTS`** environment variable. The frontend simply polls
`/api/metrics`, which already contains whatever hosts the server is polling, so there is nothing
to configure on the front end itself.

### `REMOTE_HOSTS`

A comma-separated list of hosts. Each entry may be written in any of these forms:

```
192.168.1.20
192.168.1.20:3000
http://192.168.1.20
http://192.168.1.20:9000
```

- A missing scheme is assumed to be `http://`.
- A missing port defaults to **3000** (the dashboard's own default).
- Trailing slashes are stripped and duplicates removed.

Each listed host must run an instance of this same dashboard exposing `/api/metrics` on that
address/port, since the poller scrapes that endpoint from every remote node.

```bash
# Poll two LAN hosts plus one on a non-default port
REMOTE_HOSTS="192.168.1.20,192.168.1.21:3000,192.168.1.30:9000" node src/server.js
```

With no `REMOTE_HOSTS` set the server runs in local-only mode (the poller is a no-op) and the
UI shows just this host.

### Polling behaviour tuning

| Variable                  | Default | Description                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------ |
| `REMOTE_POLL_INTERVAL_MS` | `2000`  | How often every remote host is scraped.                            |
| `REMOTE_TIMEOUT_MS`       | `3000`  | Per-request timeout; a slow/dead host never blocks the others.     |

### Docker Compose example

```yaml
services:
  dashboard:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      # The hosts this node scrapes; each must run the same dashboard on :3000
      - REMOTE_HOSTS=192.168.1.20,192.168.1.21:3000
    restart: unless-stopped
```

## Local metrics

The local node samples CPU (aggregate + per-core), memory, NVIDIA GPU (via `nvidia-smi`,
probed every 5s and skipped automatically when the binary is absent) and temperatures once a
second. Load-average based CPU usage is used on non-Windows platforms; on Windows the per-core
CPU-tick delta is used instead.

## Running

```bash
npm install      # dev dependencies only (none required at runtime beyond Node 20)
npm start        # node src/server.js
# or, with auto-reload during development:
npm run dev
```

Environment variables for the server itself:

| Variable         | Default       | Description                                                        |
| ---------------- | ------------- | ------------------------------------------------------------------ |
| `PORT`           | `3000`        | Port to listen on.                                                 |
| `HOST`           | `0.0.0.0`     | Interface to bind.                                                 |
| `SERVE_FRONTEND` | `true`        | Set to `false` to serve only `/health`, `/metrics`, `/api/metrics`.|
| `LOCAL_INSTANCE` | OS hostname   | Instance label stamped on local series in `/metrics`.              |

## Prometheus

Point a scrape job at `http://<host>:3000/metrics`. Every sample is tagged with an `instance`
label, so you can query per-host values such as:

```promql
system_cpu_usage_percent{instance="192.168.1.20:3000"}
```
