import { describe, it, expect } from 'vitest';
import {
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  assertExternalUrl,
  isSafeExternalScheme,
  isSafeBasename,
} from './safety.js';

describe('isPrivateIpv4', () => {
  it('flags RFC1918 ranges', () => {
    expect(isPrivateIpv4('10.0.0.1')).toBe(true);
    expect(isPrivateIpv4('10.255.255.255')).toBe(true);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isPrivateIpv4('192.168.1.1')).toBe(true);
  });

  it('flags loopback, link-local, CGNAT, and multicast', () => {
    expect(isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(isPrivateIpv4('169.254.169.254')).toBe(true); // AWS metadata
    expect(isPrivateIpv4('100.64.0.1')).toBe(true);
    expect(isPrivateIpv4('224.0.0.1')).toBe(true);
    expect(isPrivateIpv4('255.255.255.255')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateIpv4('1.1.1.1')).toBe(false);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('172.32.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateIpv4('192.167.255.255')).toBe(false); // just outside 192.168/16
  });

  it('respects /12 boundary precisely', () => {
    // 172.16.0.0/12 covers 172.16.0.0 – 172.31.255.255 only.
    expect(isPrivateIpv4('172.15.255.255')).toBe(false);
    expect(isPrivateIpv4('172.32.0.0')).toBe(false);
  });
});

describe('isPrivateIpv6', () => {
  it('flags loopback, link-local, ULA, multicast', () => {
    expect(isPrivateIpv6('::1')).toBe(true);
    expect(isPrivateIpv6('::')).toBe(true);
    expect(isPrivateIpv6('fe80::1')).toBe(true);
    expect(isPrivateIpv6('fc00::1')).toBe(true);
    expect(isPrivateIpv6('fd00::1')).toBe(true);
    expect(isPrivateIpv6('ff02::1')).toBe(true);
  });

  it('handles IPv4-mapped IPv6 by checking the v4 portion', () => {
    expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('does not flag public v6', () => {
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false); // Cloudflare
  });
});

describe('isPrivateIp dispatch', () => {
  it('routes to v4 / v6 by net.isIP', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
  });

  it('fails closed on garbage input', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
  });
});

describe('isSafeExternalScheme', () => {
  it('allows http and https', () => {
    expect(isSafeExternalScheme('http://example.com')).toBe(true);
    expect(isSafeExternalScheme('https://example.com/path?q=1')).toBe(true);
  });

  it('blocks file://, javascript:, data:, custom schemes', () => {
    expect(isSafeExternalScheme('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalScheme('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalScheme('data:text/html,<h1>hi</h1>')).toBe(false);
    expect(isSafeExternalScheme('slack://channel?team=x')).toBe(false);
    expect(isSafeExternalScheme('zoommtg://zoom.us/start')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isSafeExternalScheme('')).toBe(false);
    expect(isSafeExternalScheme('not-a-url')).toBe(false);
    expect(isSafeExternalScheme(null)).toBe(false);
    expect(isSafeExternalScheme(undefined)).toBe(false);
  });
});

describe('isSafeBasename', () => {
  it('allows simple filenames', () => {
    expect(isSafeBasename('book.epub')).toBe(true);
    expect(isSafeBasename('a1b2c3.cover')).toBe(true);
    expect(isSafeBasename('file with spaces.txt')).toBe(true);
  });

  it('rejects path separators (POSIX and Windows)', () => {
    expect(isSafeBasename('a/b')).toBe(false);
    expect(isSafeBasename('a\\b')).toBe(false);
    expect(isSafeBasename('/abs/path')).toBe(false);
    expect(isSafeBasename('C:\\Windows\\foo')).toBe(false);
  });

  it('rejects traversal and dot entries', () => {
    expect(isSafeBasename('..')).toBe(false);
    expect(isSafeBasename('.')).toBe(false);
    expect(isSafeBasename('../etc/passwd')).toBe(false);
  });

  it('rejects empty / non-string / NUL', () => {
    expect(isSafeBasename('')).toBe(false);
    expect(isSafeBasename(null)).toBe(false);
    expect(isSafeBasename(undefined)).toBe(false);
    expect(isSafeBasename(123)).toBe(false);
    expect(isSafeBasename('foo\0bar')).toBe(false);
  });
});

describe('assertExternalUrl', () => {
  // Inject a fake DNS resolver so tests stay offline + deterministic.
  const fakeLookup = (mapping) => async (host) => {
    if (!(host in mapping)) throw new Error(`ENOTFOUND ${host}`);
    return mapping[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it('rejects non-http(s) schemes synchronously', async () => {
    await expect(assertExternalUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertExternalUrl('javascript:alert(1)')).rejects.toThrow(/http/);
  });

  it('rejects literal private IPs without DNS', async () => {
    await expect(assertExternalUrl('http://127.0.0.1/'))
      .rejects.toThrow(/internal/);
    await expect(assertExternalUrl('http://192.168.1.1/'))
      .rejects.toThrow(/internal/);
    await expect(assertExternalUrl('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/internal/);
  });

  it('rejects "localhost" and *.local hosts', async () => {
    await expect(assertExternalUrl('http://localhost/')).rejects.toThrow(/internal/);
    await expect(assertExternalUrl('http://router.local/')).rejects.toThrow(/internal/);
    await expect(assertExternalUrl('http://my.localhost/')).rejects.toThrow(/internal/);
  });

  it('rejects hosts whose DNS resolves to a private address', async () => {
    const lookup = fakeLookup({ 'evil.example': ['192.168.1.1'] });
    await expect(assertExternalUrl('http://evil.example/x', { lookup }))
      .rejects.toThrow(/internal/);
  });

  it('rejects when ANY resolved address is private', async () => {
    const lookup = fakeLookup({ 'mixed.example': ['8.8.8.8', '10.0.0.1'] });
    await expect(assertExternalUrl('http://mixed.example/', { lookup }))
      .rejects.toThrow(/internal/);
  });

  it('allows public IPs', async () => {
    await expect(assertExternalUrl('http://1.1.1.1/')).resolves.toBeUndefined();
  });

  it('allows hosts that resolve only to public addresses', async () => {
    const lookup = fakeLookup({ 'good.example': ['1.1.1.1', '8.8.8.8'] });
    await expect(assertExternalUrl('http://good.example/', { lookup }))
      .resolves.toBeUndefined();
  });
});
