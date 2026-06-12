import * as http from 'node:http';

// In-memory rate limiter (per client IP, sliding minute window). Behind the
// production reverse proxy, connections arrive from a private address, so we
// trust X-Forwarded-For only from private/loopback sources (or an explicit
// TRUSTED_PROXY_IPS list).
const WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

const attempts = new Map<string, number[]>();

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  const oct172 = /^172\.(\d{1,3})\./.exec(ip);
  if (oct172) {
    const o = Number(oct172[1]);
    return o >= 16 && o <= 31;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

function isTrustedProxy(ip: string): boolean {
  const configured = process.env.TRUSTED_PROXY_IPS;
  if (configured) {
    return configured.split(',').map((s) => normalizeIp(s.trim())).filter(Boolean).includes(ip);
  }
  return isPrivateOrLoopback(ip);
}

export function requestIp(req: http.IncomingMessage): string {
  const remote = normalizeIp(String(req.socket?.remoteAddress ?? 'unknown').trim());
  if (!isTrustedProxy(remote)) return remote;
  const chain = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i])) return chain[i];
  }
  return chain[0] ?? remote;
}

export function rateLimited(req: http.IncomingMessage, maxPerMinute = 20): boolean {
  const ip = requestIp(req);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const list = (attempts.get(ip) ?? []).filter((t) => t > windowStart);
  const updated = [...list, now];
  attempts.set(ip, updated);
  if (attempts.size > MAX_TRACKED_IPS) attempts.clear(); // memory backstop
  return updated.length > maxPerMinute;
}
