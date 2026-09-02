'use strict';

/**
 * RemotePoller — periodically scrapes the /api/metrics endpoint of every host listed
 * in REMOTE_HOSTS and stores the result in the shared RemoteRegistry. Each request is
 * independent (timeout + try/catch) so one dead host never blocks or skews the others.
 * Node built-ins only.
 */

const http = require('http');

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_PORT = 3000;

/**
 * Normalizes one REMOTE_HOSTS entry to a base URL: prepends http:// when no scheme is
 * present and appends :3000 when the host carries no explicit port. Returns null for
 * blank entries.
 */
function normalizeHost(entry, defaultPort = DEFAULT_PORT) {
  let raw = String(entry || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const parsed = new URL(raw);
    if (!parsed.port) parsed.port = String(defaultPort);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

/** Splits the comma-separated REMOTE_HOSTS value into normalized, de-duplicated URLs. */
function normalizeHosts(value) {
  const seen = new Set();
  const urls = [];
  for (const part of String(value || '').split(',')) {
    const url = normalizeHost(part);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** GET <base>/api/metrics with a hard timeout; resolves with parsed JSON. */
function fetchMetricsJson(baseUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL('/api/metrics', baseUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const request = http.get(target, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${target.href}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`invalid JSON from ${target.href}: ${error.message}`));
        }
      });
      res.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request to ${target.href} timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

/**
 * Extracts the flat metrics block from a remote /api/metrics payload. Deployments
 * shape this differently: current versions put the flat block at payload.local, while
 * older/aggregate responses nest it one level deeper under payload.local.local. This
 * descends `local` until reaching a block that carries real memory/cpu data, then
 * normalizes to { cpu, memory, gpu, temperatures, ... } so both the frontend and the
 * Prometheus renderer see a consistent shape regardless of the remote's version.
 */
function extractRemoteMetrics(payload) {
  let node = payload && typeof payload === 'object' ? payload.local : null;
  while (node && typeof node === 'object' && node.local && !node.memory) {
    node = node.local;
  }
  if (!node || typeof node !== 'object') return null;
  return {
    timestamp: node.timestamp,
    cpu: node.cpu || {},
    memory: node.memory || {},
    gpu: Array.isArray(node.gpu) ? node.gpu : [],
    temperatures: node.temperatures || {},
    platform: node.platform,
    hostname: node.hostname,
  };
}

/** Polls one host and writes the outcome into the registry, preserving lastSuccessAt on failure. */
async function pollHost(registry, url, timeoutMs) {
  try {
    const payload = await fetchMetricsJson(url, timeoutMs);
    const data = extractRemoteMetrics(payload);
    registry.set(url, {
      status: 'ok',
      lastSuccessAt: new Date().toISOString(),
      data,
      error: null,
    });
  } catch (error) {
    // registry keys are normalized "host:port"; look up prior state by either form.
    let prior = null;
    try {
      prior = registry.get(url) || registry.get(new URL(url).host);
    } catch (_) {
      prior = registry.get(url);
    }
    registry.set(url, {
      status: 'error',
      lastSuccessAt: prior && prior.lastSuccessAt ? prior.lastSuccessAt : null,
      data: null,
      error: error.message || String(error),
    });
  }
}

/**
 * Starts the poll loop. With no REMOTE_HOSTS configured this is a no-op and returns
 * null (local-only mode). Returns a handle { urls, intervalMs, timeoutMs, runOnce, stop }.
 */
function startRemotePoller(registry) {
  const urls = normalizeHosts(process.env.REMOTE_HOSTS);
  if (!urls.length) return null;

  const intervalMs = Number(process.env.REMOTE_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = Number(process.env.REMOTE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const runOnce = () => Promise.allSettled(urls.map((url) => pollHost(registry, url, timeoutMs)));

  // First cycle immediately so /health is populated without waiting a full interval.
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    urls,
    intervalMs,
    timeoutMs,
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { startRemotePoller, normalizeHost, normalizeHosts, fetchMetricsJson, pollHost, extractRemoteMetrics };
