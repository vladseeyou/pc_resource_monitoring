'use strict';

/**
 * Minimal HTTP server (no framework) exposing the collected metrics as Prometheus
 * text exposition format on /metrics and as JSON on /api/metrics, plus a lightweight
 * JSON /health endpoint. The static frontend from public/ is served only when
 * SERVE_FRONTEND is not set to "false".
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { collector } = require('./metrics');
const { remoteRegistry } = require('./remote');
const { startRemotePoller } = require('./remotePoller');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// When SERVE_FRONTEND=false the static UI is not served (GET / -> 404); /health,
// /metrics and /api/metrics keep working. Useful for a minimal health/scrape node.
const SERVE_FRONTEND = process.env.SERVE_FRONTEND !== 'false';
// Instance id stamped on every local series in /metrics (remote hosts keep their own).
const LOCAL_INSTANCE = process.env.LOCAL_INSTANCE || os.hostname();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Semicolon-separated media-type parameters: Node's HTTP header validation rejects a
// comma here (it throws "invalid parameter format"), and RFC 2045 parameters are `;` split.
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const STATIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const entries = Object.entries(labels || {}).filter(([, value]) => value !== null && value !== undefined);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function sample(name, labels, value) {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : null;
  return numeric === null ? null : `${name}${formatLabels(labels)} ${numeric}`;
}

function help(name, text) {
  return `# HELP ${name} ${text}`;
}

function type(name, metricType) {
  return `# TYPE ${name} ${metricType}`;
}

/** Guards partial remote payloads so one odd host cannot break the whole exposition. */
function safeMetrics(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  return {
    cpu: source.cpu || {},
    memory: source.memory || {},
    gpu: Array.isArray(source.gpu) ? source.gpu : [],
    temperatures: source.temperatures || {},
    platform: source.platform,
    hostname: source.hostname,
  };
}

/**
 * Ordered metric family table. Each `series` maps one host's metrics object to
 * { labels, value } pairs; the renderer injects the instance label and emits each
 * family's HELP/TYPE exactly once across all hosts.
 */
const METRIC_FAMILIES = [
  {
    name: 'system_cpu_usage_percent',
    type: 'gauge',
    help: 'Instantaneous CPU utilization in percent (0-100).',
    series: (m) => {
      const lines = [{ labels: { core: 'aggregate' }, value: m.cpu.usagePercent }];
      const perCore = Array.isArray(m.cpu.perCoreUsagePercent) ? m.cpu.perCoreUsagePercent : [];
      perCore.forEach((value, index) => {
        lines.push({ labels: { core: String(index) }, value });
      });
      return lines;
    },
  },
  {
    name: 'system_cpu_core_count',
    type: 'gauge',
    help: 'Number of logical CPU cores.',
    series: (m) => [{ labels: null, value: m.cpu.cores }],
  },
  {
    name: 'system_load_average',
    type: 'gauge',
    help: 'System load average for the labelled interval.',
    series: (m) => {
      const loadAvg = Array.isArray(m.cpu.loadAvg) ? m.cpu.loadAvg : [];
      return ['1m', '5m', '15m'].map((interval, index) => ({
        labels: { interval },
        value: loadAvg[index],
      }));
    },
  },
  {
    name: 'system_memory_total_bytes',
    type: 'gauge',
    help: 'Total physical memory in bytes.',
    series: (m) => [{ labels: null, value: Math.round(m.memory.totalMB * 1024 * 1024) }],
  },
  {
    name: 'system_memory_used_bytes',
    type: 'gauge',
    help: 'Used physical memory in bytes.',
    series: (m) => [{ labels: null, value: Math.round(m.memory.usedMB * 1024 * 1024) }],
  },
  {
    name: 'system_memory_free_bytes',
    type: 'gauge',
    help: 'Free physical memory in bytes.',
    series: (m) => [{ labels: null, value: Math.round(m.memory.freeMB * 1024 * 1024) }],
  },
  {
    name: 'system_memory_utilization_ratio',
    type: 'gauge',
    help: 'Used physical memory as a ratio of total (0-1).',
    series: (m) => [
      {
        labels: null,
        value: m.memory.percentUsed === null ? null : Number(m.memory.percentUsed) / 100,
      },
    ],
  },
  {
    name: 'gpu_usage_percent',
    type: 'gauge',
    help: 'GPU utilization in percent (0-100).',
    series: (m) => m.gpu.map((gpu) => ({ labels: { name: `${gpu.index} ${gpu.name}` }, value: gpu.usagePercent })),
  },
  {
    name: 'gpu_memory_used_bytes',
    type: 'gauge',
    help: 'GPU used memory in bytes.',
    series: (m) => m.gpu.map((gpu) => ({ labels: { name: `${gpu.index} ${gpu.name}` }, value: gpu.memUsedMB * 1024 * 1024 })),
  },
  {
    name: 'gpu_memory_total_bytes',
    type: 'gauge',
    help: 'GPU total memory in bytes.',
    series: (m) => m.gpu.map((gpu) => ({ labels: { name: `${gpu.index} ${gpu.name}` }, value: gpu.memTotalMB * 1024 * 1024 })),
  },
  {
    name: 'gpu_temperature_celsius',
    type: 'gauge',
    help: 'GPU temperature in degrees Celsius.',
    series: (m) => m.gpu.map((gpu) => ({ labels: { name: `${gpu.index} ${gpu.name}` }, value: gpu.temperatureC })),
  },
  {
    name: 'temperature_celsius',
    type: 'gauge',
    help: 'Sensor temperature in degrees Celsius.',
    series: (m) => {
      const lines = [];
      if (m.temperatures.cpuCelsius !== null && m.temperatures.cpuCelsius !== undefined) {
        lines.push({ labels: { sensor: 'cpu' }, value: m.temperatures.cpuCelsius });
      }
      if (m.temperatures.gpuCelsius !== null && m.temperatures.gpuCelsius !== undefined) {
        lines.push({ labels: { sensor: 'gpu' }, value: m.temperatures.gpuCelsius });
      }
      return lines;
    },
  },
  {
    name: 'dashboard_info',
    type: 'gauge',
    help: 'Dashboard build metadata; value is always 1.',
    series: (m) => [{ labels: { platform: m.platform, hostname: m.hostname }, value: 1 }],
  },
  {
    name: 'scrape_timestamp_seconds',
    type: 'gauge',
    help: 'Unix timestamp in seconds of this scrape.',
    localOnly: true,
    series: () => [{ labels: null, value: Math.floor(Date.now() / 1000) }],
  },
];

/**
 * Renders the aggregate snapshot (local metrics + polled remote hosts) in Prometheus
 * text exposition format 0.0.4. HELP/TYPE appear once per family; every sample carries
 * an instance label so a single scrape can tell all hosts apart.
 */
function renderPrometheus(metrics, hosts = [], localInstance = LOCAL_INSTANCE) {
  const targets = [{ instance: localInstance, metrics: safeMetrics(metrics) }];
  for (const host of hosts || []) {
    if (!host || !host.data) continue; // remote in error state carries no data
    targets.push({ instance: host.instance, metrics: safeMetrics(host.data) });
  }

  const lines = [];
  const push = (line) => {
    if (line !== null && line !== undefined) lines.push(line);
  };

  for (const family of METRIC_FAMILIES) {
    push(help(family.name, family.help));
    push(type(family.name, family.type));
    for (const target of targets) {
      if (family.localOnly && target !== targets[0]) continue;
      for (const { labels, value } of family.series(target.metrics)) {
        push(sample(family.name, { instance: target.instance, ...(labels || {}) }, value));
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

function serveStatic(res, filePath) {
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    sendText(res, 400, 'Bad Request', 'text/plain; charset=utf-8');
    return;
  }
  pathname = decodeURIComponent(pathname);

  if (req.method === 'GET' && pathname === '/metrics') {
    try {
      const metrics = await collector.getMetrics();
      sendText(res, 200, renderPrometheus(metrics, remoteRegistry.list(), LOCAL_INSTANCE), PROMETHEUS_CONTENT_TYPE);
    } catch (error) {
      sendText(res, 500, `# error collecting metrics: ${error.message}\n`, 'text/plain; charset=utf-8');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/metrics') {
    try {
      const metrics = await collector.getMetrics();
      const aggregate = {
        timestamp: new Date().toISOString(),
        local: metrics,
        hosts: remoteRegistry.list().map(({ instance, url, status, lastSuccessAt, error, data }) => ({
          instance,
          url,
          status,
          lastSuccessAt: lastSuccessAt === undefined ? null : lastSuccessAt,
          error: error === undefined ? null : error,
          data: data === undefined ? null : data,
        })),
      };
      sendText(res, 200, JSON.stringify(aggregate), 'application/json; charset=utf-8');
    } catch (error) {
      sendText(res, 500, JSON.stringify({ error: 'failed to collect metrics', detail: error.message }), 'application/json; charset=utf-8');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendText(res, 200, JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      platform: process.platform,
      hostname: os.hostname(),
      remotes: remoteRegistry.statuses(),
    }), 'application/json; charset=utf-8');
    return;
  }

  if (req.method === 'GET') {
    if (!SERVE_FRONTEND) {
      sendText(res, 404, 'frontend disabled', 'text/plain; charset=utf-8');
      return;
    }
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    serveStatic(res, path.join(PUBLIC_DIR, relativePath));
    return;
  }

  sendText(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
});

startRemotePoller(remoteRegistry);

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}${SERVE_FRONTEND ? '' : ' (frontend disabled)'}`);
});

module.exports = { server, renderPrometheus };
