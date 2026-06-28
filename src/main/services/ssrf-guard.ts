// ssrf-guard.ts — the STRICT egress guard for agent-driven BACKGROUND fetches (the Monitor http probe and,
// later, the http hook). It is deliberately stricter than preview-url-guard.ts: that guard governs PREVIEW
// NAVIGATION and intentionally permits localhost / private LAN (previewing a local dev server is a core
// feature). These background fetches instead run on a repeating schedule and return the response BODY to the
// model — a far better SSRF / exfiltration / internal-port-scan primitive — so they get the production policy:
// http/https only, and the host's RESOLVED IP must be a public address (loopback, RFC1918 private, CGNAT,
// link-local, IPv6 ULA, unspecified, and cloud-metadata ranges are all rejected). Resolving the host first
// also defeats decimal/hex/octal IP encodings (e.g. http://2852039166) that a string check would miss.
//
// Residual: without pinning the socket to the validated IP there is a narrow DNS-rebinding TOCTOU window
// between this lookup and the fetch's own lookup. The http hook (batch 4) closes it with a pinned custom DNS
// lookup; for the Monitor probe the resolve-then-check policy here is the proportionate guard.

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

interface ValidatedAddr {
  address: string
  family: number
}

// Resolve a URL's host to its IP(s) and assert EVERY one is public. Returns the validated addresses so a caller
// can PIN the connection to them (closing the DNS-rebinding window between this check and the fetch's own lookup).
async function resolveAndValidate(url: string): Promise<ValidatedAddr[]> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`rejected: unparsable URL "${url}".`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`rejected: only http/https URLs are allowed (got "${parsed.protocol}").`)
  }
  const host = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') ? parsed.hostname.slice(1, -1) : parsed.hostname
  let addrs: ValidatedAddr[]
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }]
  } else {
    try {
      addrs = (await lookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family }))
    } catch {
      throw new Error(`rejected: could not resolve host "${host}".`)
    }
  }
  if (addrs.length === 0) throw new Error(`rejected: host "${host}" resolved to no address.`)
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new Error(`rejected: host "${host}" resolves to a private/loopback/link-local/metadata address (${a.address}), which is not allowed.`)
    }
  }
  return addrs
}

export async function assertPublicHttpUrl(url: string): Promise<void> {
  await resolveAndValidate(url)
}

// SSRF-safe fetch: validate the URL, then PIN the socket to the validated IP via a custom dispatcher lookup so
// the connection cannot be rebound to a private/metadata address after the check (DNS-rebinding TOCTOU). The
// original Host header / SNI are preserved (we only override the address the resolver returns). Callers should
// still pass redirect:'manual' — a 3xx Location would otherwise re-resolve an unvalidated host.
export async function safeFetch(url: string, init?: Parameters<typeof undiciFetch>[1]): Promise<Response> {
  const addrs = await resolveAndValidate(url)
  const pinned = addrs[0]
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, cb: (err: Error | null, address: string, family: number) => void) => cb(null, pinned.address, pinned.family),
    },
  })
  return undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Response
}

// Private / loopback / link-local / CGNAT / cloud-metadata / ULA / multicast / unspecified ranges. We use
// net.BlockList because it CANONICALISES the address before matching — crucially it judges an IPv4-mapped IPv6
// against the IPv4 rules in BOTH the dotted form (::ffff:169.254.169.254) and the dotless HEX form
// (::ffff:a9fe:a9fe), which is what the WHATWG URL parser (`new URL(...).hostname`) actually serialises. A
// hand-rolled prefix check misses the hex form and lets ::ffff:<metadata> through; BlockList does not.
const BLOCKED = new BlockList()
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4') // "this network" / unspecified
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4') // private
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4') // CGNAT (100.64.0.0/10)
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4') // link-local + cloud metadata (169.254.169.254)
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4') // private
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4') // private
BLOCKED.addAddress('::', 'ipv6') // unspecified
BLOCKED.addAddress('::1', 'ipv6') // loopback
BLOCKED.addSubnet('fc00::', 7, 'ipv6') // unique-local fc00::/7
BLOCKED.addSubnet('fe80::', 10, 'ipv6') // link-local fe80::/10
BLOCKED.addSubnet('ff00::', 8, 'ipv6') // multicast

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 0) return true // unparseable → fail closed
  return BLOCKED.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}
