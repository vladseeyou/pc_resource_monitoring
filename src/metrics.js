'use strict';

/**
 * MetricsCollector — samples CPU / memory / GPU / temperature once per second and
 * caches the newest reading behind an async getter. Node built-ins only.
 */

const os = require('os');
const { spawn } = require('child_process');

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_GPU_TIMEOUT_MS = 1500;
const DEFAULT_GPU_PROBE_INTERVAL_MS = 5000;
const BYTES_PER_MB = 1024 * 1024;

// os.loadavg() is unimplemented on Windows and always reports [0, 0, 0]. On those
// platforms the load-average based CPU formula cannot produce a meaningful value, so
// per-core CPU tick deltas are used for the headline percentage instead.
const LOADAVG_SUPPORTED = process.platform !== 'win32';

const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toMB(bytes) {
  return round(bytes / BYTES_PER_MB, 1);
}

/** Runs a binary, capturing stdout/stderr. Rejects on spawn failure or timeout kill. */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (callback, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(payload);
    };

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* already gone */
      }
      finish(reject, new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => finish(reject, error));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/** Parses nvidia-smi csv output; tolerant of quoted names containing commas. */
function parseNvidiaSmi(stdout) {
  const gpus = [];
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^index,/i.test(line)) continue;

    const fields = line.split(',').map((field) => field.trim().replace(/^"|"$/g, ''));
    if (fields.length < 6) continue;

    const index = Number(fields[0]);
    const temperatureC = Number(fields[5]);
    const memTotalMB = Number(fields[4]);
    const memUsedMB = Number(fields[3]);
    const usagePercent = Number(fields[2]);
    const name = fields.slice(1, 2).join(' ').trim() || `GPU ${index}`;
    if (!Number.isFinite(index)) continue;

    gpus.push({
      index,
      name,
      usagePercent: Number.isFinite(usagePercent) ? clamp(round(usagePercent, 1), 0, 100) : null,
      memUsedMB: Number.isFinite(memUsedMB) ? round(memUsedMB, 1) : null,
      memTotalMB: Number.isFinite(memTotalMB) ? round(memTotalMB, 1) : null,
      temperatureC: Number.isFinite(temperatureC) ? round(temperatureC, 1) : null,
    });
  }
  return gpus.sort((a, b) => a.index - b.index);
}

class MetricsCollector {
  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    gpuTimeoutMs = DEFAULT_GPU_TIMEOUT_MS,
    gpuProbeIntervalMs = DEFAULT_GPU_PROBE_INTERVAL_MS,
  } = {}) {
    this.intervalMs = intervalMs;
    this.gpuTimeoutMs = gpuTimeoutMs;
    this.gpuProbeIntervalMs = gpuProbeIntervalMs;

    this.latest = null;
    this.timer = null;

    this._previousCpuSample = null;
    this._gpus = [];
    this._gpuAvailable = false;
    this._gpuProbePermanentlyDisabled = false;
    this._gpuProbeInFlight = null;
    this._lastProbeAt = 0;
  }

  /** Begins polling. Idempotent. */
  start() {
    if (this.timer) return this;
    this._previousCpuSample = this._takeCpuSample();
    this.timer = setInterval(() => {
      this.collect().catch(() => {
        /* a failed sample never stops the loop; latest stays at last good reading */
      });
    }, this.intervalMs);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** Resolves with the cached reading, sampling on demand if the cache is cold or stale. */
  async getMetrics() {
    const ageMs = this.latest ? Date.now() - Date.parse(this.latest.timestamp) : Infinity;
    if (ageMs > this.intervalMs * 2) await this.collect();
    return this.latest;
  }

  /** Takes one reading of every source and refreshes the cache. */
  async collect() {
    const currentCpuSample = this._takeCpuSample();
    const previous = this._previousCpuSample || currentCpuSample;
    this._previousCpuSample = currentCpuSample;

    const cpuUsage = this._computeCpuUsage(previous, currentCpuSample);
    const gpus = await this._probeGpus();
    const temperatures = this._readTemperatures(gpus);

    const snapshot = {
      timestamp: new Date().toISOString(),
      cpu: {
        usagePercent: cpuUsage.usagePercent,
        cores: currentCpuSample.cores.length,
        loadAvg: os.loadavg().map((value) => round(value, 2)),
        perCoreUsagePercent: cpuUsage.perCore,
      },
      memory: this._readMemory(),
      gpu: gpus.map((gpu) => ({ ...gpu })),
      temperatures,
      platform: process.platform,
      hostname: os.hostname(),
    };

    this.latest = snapshot;
    return snapshot;
  }

  _takeCpuSample() {
    return {
      timestampMs: Date.now(),
      load1: os.loadavg()[0],
      cores: os.cpus().map((cpu) => ({
        idle: cpu.times.idle,
        total: Object.values(cpu.times).reduce((sum, ticks) => sum + ticks, 0),
      })),
    };
  }

  _computeCpuUsage(previous, current) {
    const elapsedSeconds = Math.max((current.timestampMs - previous.timestampMs) / 1000, 1e-3);
    const coreCount = current.cores.length || 1;

    const perCore = current.cores.map((core, i) => {
      const before = previous.cores[i];
      if (!before) return null;
      const totalDelta = core.total - before.total;
      const idleDelta = core.idle - before.idle;
      if (totalDelta <= 0) return 0;
      return round(clamp((1 - idleDelta / totalDelta) * 100, 0, 100), 2);
    });

    let usagePercent;
    if (LOADAVG_SUPPORTED) {
      // Spec formula: delta of the 1 minute load average over the sample interval, per core.
      usagePercent = clamp(
        ((current.load1 - previous.load1) / elapsedSeconds / coreCount) * 100,
        0,
        100
      );
    } else {
      const usable = perCore.filter((value) => Number.isFinite(value));
      const mean = usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
      usagePercent = clamp(mean, 0, 100);
    }

    return { usagePercent: round(usagePercent, 2), perCore };
  }

  _readMemory() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(totalBytes - freeBytes, 0);
    return {
      totalMB: toMB(totalBytes),
      usedMB: toMB(usedBytes),
      freeMB: toMB(freeBytes),
      percentUsed: round(clamp((usedBytes / (totalBytes || 1)) * 100, 0, 100), 2),
    };
  }

  /** Best-effort NVIDIA probe; never throws and never blocks past gpuTimeoutMs. */
  _probeGpus() {
    if (this._gpuProbePermanentlyDisabled) return Promise.resolve(this._gpus);

    // Throttled spawn: between probes report the last-known GPU values instead of
    // paying for a child process every polling cycle.
    const now = Date.now();
    const withinThrottleWindow =
      this._lastProbeAt > 0 && now - this._lastProbeAt < this.gpuProbeIntervalMs;
    if (withinThrottleWindow && !this._gpuProbeInFlight) return Promise.resolve(this._gpus);
    if (this._gpuProbeInFlight) return this._gpuProbeInFlight;

    this._lastProbeAt = now;
    this._gpuProbeInFlight = runCommand('nvidia-smi', NVIDIA_SMI_ARGS, this.gpuTimeoutMs)
      .then((stdout) => {
        this._gpus = parseNvidiaSmi(stdout);
        this._gpuAvailable = this._gpus.length > 0;
        return this._gpus;
      })
      .catch((error) => {
        const missing = error && (error.code === 'ENOENT' || error.code === 'ENONET');
        this._gpus = [];
        this._gpuAvailable = false;
        // A missing binary will not appear mid-run: stop spawning it every second.
        if (missing) this._gpuProbePermanentlyDisabled = true;
        return this._gpus;
      })
      .finally(() => {
        this._gpuProbeInFlight = null;
      });

    return this._gpuProbeInFlight;
  }

  _readTemperatures(gpus) {
    const gpuReadings = gpus
      .map((gpu) => gpu.temperatureC)
      .filter((value) => Number.isFinite(value));
    // CPU package temperature has no dependency-free cross-platform source; the GPU
    // query is the only sensor read here, so cpuCelsius stays null without tooling.
    const cpuCelsius = null;
    const gpuCelsius = gpuReadings.length ? Math.max(...gpuReadings) : null;

    return {
      cpuCelsius,
      gpuCelsius,
      availability: cpuCelsius !== null || gpuCelsius !== null,
      gpuAvailability: this._gpuAvailable,
    };
  }
}

const collector = new MetricsCollector();
collector.start();

module.exports = { MetricsCollector, collector, parseNvidiaSmi };
