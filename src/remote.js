'use strict';

/**
 * Registry of remote metric hosts polled over the LAN. A single shared instance so
 * both the /health endpoint and the aggregated endpoints can read live status
 * without triggering new scrapes. Populated by the RemotePoller (see backend task).
 */

class RemoteRegistry {
  constructor() {
    /** @type {Map<string, object>} keyed by normalized "host:port" instance id */
    this.hosts = new Map();
  }

  set(url, entry) {
    const instance = RemoteRegistry.instanceOf(url);
    this.hosts.set(instance, Object.assign({ url, instance }, entry));
  }

  remove(url) {
    this.hosts.delete(RemoteRegistry.instanceOf(url));
  }

  get(instance) {
    return this.hosts.get(instance) || null;
  }

  list() {
    return [...this.hosts.values()].sort((a, b) => a.instance.localeCompare(b.instance));
  }

  /** Lightweight status summary for /health (no metric payloads). */
  statuses() {
    return this.list().map(({ instance, url, status, lastSuccessAt, error }) => ({
      instance,
      url,
      status,
      lastSuccessAt,
      error,
    }));
  }

  static instanceOf(url) {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    try {
      return new URL(raw).host; // host:port, e.g. 192.168.1.10:3000
    } catch {
      return raw.replace(/^https?:\/\//i, '');
    }
  }
}

const remoteRegistry = new RemoteRegistry();

module.exports = { RemoteRegistry, remoteRegistry };
