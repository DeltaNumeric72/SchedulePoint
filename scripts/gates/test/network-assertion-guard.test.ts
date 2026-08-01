import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { analyze, findExternalUrls, loadAllowlist } from '../network-assertion-guard.mjs';

/**
 * Network-assertion guard tests — SP-HR-1.
 *
 * The guard's whole value rests on two things: it must catch the forms an
 * outbound host actually takes in client code, and it must not be so noisy that
 * someone weakens it. Both directions are tested.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

interface Allowlist {
  requestHosts: string[];
  vendorStringHosts: { host: string; reason: string }[];
}

const EMPTY: Allowlist = { requestHosts: [], vendorStringHosts: [] };

function scan(source: string, allowlist: Allowlist = EMPTY, vendorStrings = false): Violation[] {
  return analyze({
    files: [{ path: 'inline', source }],
    allowlist,
    vendorStrings,
  }) as Violation[];
}

describe('detects outbound hosts in every shape they arrive in', () => {
  it.each([
    ['fetch', `fetch("https://analytics.example.com/collect")`],
    ['protocol-relative', `const s = "//cdn.example.net/lib.js";`],
    ['websocket', `new WebSocket("wss://socket.example.org/live")`],
    ['image beacon', `img.src = "http://pixel.example.com/p.gif?id=1";`],
    ['css font import', `@import url("https://fonts.example.com/css?family=X");`],
    ['bare IP address', `fetch("http://203.0.113.10:8080/ingest")`],
    ['inside a comment', `// TODO: point this at https://staging.example.com`],
  ])('%s', (_name, source) => {
    expect(scan(source).length).toBeGreaterThan(0);
  });

  it('flags localhost too — a hardcoded dev URL must not ship', () => {
    expect(scan(`fetch("http://localhost:3001/api/health")`).length).toBe(1);
  });

  it('names the host in the message', () => {
    expect(scan(`fetch("https://analytics.example.com/x")`)[0]?.detail).toContain(
      'analytics.example.com',
    );
  });

  it('reports the correct line', () => {
    expect(scan(`a\nb\nfetch("https://x.example.com")\n`)[0]?.line).toBe(3);
  });
});

describe('does not flag same-origin work', () => {
  it.each([
    `fetch("/api/health")`,
    `fetch(\`\${API_PREFIX}/health\`)`,
    `const path = "./styles/tokens.css";`,
    `// see the notes in ../api/client.ts`,
    `const ratio = a / b / c;`,
    `url(data:image/svg+xml;base64,AAAA)`,
  ])('%s', (source) => {
    expect(scan(source)).toEqual([]);
  });
});

describe('allowlist behaviour', () => {
  it('honours an allowlisted request host', () => {
    expect(
      scan(`fetch("https://allowed.example.com/x")`, {
        requestHosts: ['allowed.example.com'],
        vendorStringHosts: [],
      }),
    ).toEqual([]);
  });

  const vendorAllowlist: Allowlist = {
    requestHosts: [],
    vendorStringHosts: [{ host: 'vendor.example.com', reason: 'error message text' }],
  };

  it('applies vendorStringHosts to the bundle scan only', () => {
    const text = `throw Error("see https://vendor.example.com/errors")`;
    expect(scan(text, vendorAllowlist, true)).toEqual([]);
    // First-party source: never tolerated, whatever the vendor list says.
    expect(scan(text, vendorAllowlist, false)).toHaveLength(1);
  });

  it.each([
    `fetch("https://vendor.example.com/collect")`,
    `new WebSocket("wss://vendor.example.com/live")`,
    `navigator.sendBeacon("https://vendor.example.com/b")`,
    `el.src = "https://vendor.example.com/p.gif"`,
  ])('rejects an allowlisted vendor host in a request context: %s', (source) => {
    const violations = scan(source, vendorAllowlist, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('appears in a REQUEST context');
  });

  it('the shipped requestHosts allowlist is empty — SP-HR-1 has no exceptions', () => {
    const shipped = loadAllowlist() as Allowlist;
    expect(shipped.requestHosts).toEqual([]);
  });

  it('every shipped vendor-string entry states a reason', () => {
    const shipped = loadAllowlist() as Allowlist;
    expect(shipped.vendorStringHosts.length).toBeGreaterThan(0);
    for (const entry of shipped.vendorStringHosts) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });
});

describe('findExternalUrls', () => {
  it('lowercases the extracted host', () => {
    const [hit] = findExternalUrls('https://CDN.Example.COM/a') as { host: string }[];
    expect(hit?.host).toBe('cdn.example.com');
  });

  it('finds every occurrence, not just the first', () => {
    expect(findExternalUrls('https://a.example.com https://b.example.com')).toHaveLength(2);
  });
});
