import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsPromisesLookup } from "node:dns/promises";
import { lookup as dnsCallbackLookup } from "node:dns";
import { assertSafeUrl, guardedLookup, isPrivateIp, isPrivateIpv4 } from "./webfetch.server";

// assertSafeUrl resolves via node:dns/promises; guardedLookup (the connect-time
// SSRF guard) resolves via node:dns's callback API. Mock both so no test ever
// touches real DNS.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: vi.fn() }));

const mockedPromisesLookup = vi.mocked(dnsPromisesLookup);
const mockedCallbackLookup = vi.mocked(dnsCallbackLookup);

const PUBLIC_A: LookupAddress = { address: "93.184.216.34", family: 4 };
const PRIVATE_A: LookupAddress = { address: "10.0.0.5", family: 4 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isPrivateIpv4", () => {
  const blocked = [
    "0.1.2.3", // 0.0.0.0/8
    "10.0.0.1", // 10/8
    "127.0.0.1", // loopback
    "100.64.0.1", // CGNAT lower edge
    "100.127.255.255", // CGNAT upper edge
    "169.254.169.254", // link-local (cloud metadata)
    "172.16.0.1", // 172.16/12 lower edge
    "172.31.255.255", // 172.16/12 upper edge
    "192.168.1.1", // 192.168/16
    "192.0.0.1", // 192.0.0/24 special-use
    "198.18.0.1", // benchmarking
    "198.19.255.255", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isPrivateIpv4(ip)).toBe(true));
  }

  const publicIps = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "198.17.0.1", // just below benchmarking
    "198.20.0.1", // just above benchmarking
    "223.255.255.255", // just below multicast
  ];
  for (const ip of publicIps) {
    it(`allows ${ip}`, () => expect(isPrivateIpv4(ip)).toBe(false));
  }

  it("treats malformed dotted quads as blocked", () => {
    expect(isPrivateIpv4("1.2.3")).toBe(true);
    expect(isPrivateIpv4("a.b.c.d")).toBe(true);
  });
});

describe("isPrivateIp", () => {
  const blockedV6 = [
    "::", // unspecified
    "::1", // loopback
    "fc00::1", // unique local fc00::/7
    "fd12:3456::1",
    "fe80::1", // link-local fe80::/10
    "fe9f::1",
    "fea0::1",
    "febf::1",
    "::ffff:10.0.0.1", // v4-mapped private
    "::ffff:192.168.0.1",
  ];
  for (const ip of blockedV6) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }

  it("allows public IPv6 and v4-mapped public addresses", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("delegates plain IPv4 to isPrivateIpv4", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("treats non-IP strings as blocked", () => {
    expect(isPrivateIp("example.com")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("rejects non-https schemes", async () => {
    await expect(assertSafeUrl("http://example.com/")).rejects.toThrow(/Only https/);
    await expect(assertSafeUrl("ftp://example.com/")).rejects.toThrow(/Only https/);
  });

  it("rejects invalid URLs", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toThrow(/Not a valid URL/);
  });

  it("rejects localhost and internal-style hostnames without touching DNS", async () => {
    await expect(assertSafeUrl("https://localhost/")).rejects.toThrow(/Blocked host/);
    await expect(assertSafeUrl("https://api.localhost/")).rejects.toThrow(/Blocked host/);
    await expect(assertSafeUrl("https://metadata.internal/")).rejects.toThrow(/Blocked host/);
    await expect(assertSafeUrl("https://printer.local/")).rejects.toThrow(/Blocked host/);
    expect(mockedPromisesLookup).not.toHaveBeenCalled();
  });

  it("rejects private IP literals without touching DNS", async () => {
    await expect(assertSafeUrl("https://10.0.0.1/")).rejects.toThrow(/private address/);
    await expect(assertSafeUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private address/);
    expect(mockedPromisesLookup).not.toHaveBeenCalled();
  });

  it("accepts a public IP literal without touching DNS", async () => {
    const url = await assertSafeUrl("https://8.8.8.8/resolve");
    expect(url.hostname).toBe("8.8.8.8");
    expect(mockedPromisesLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    mockedPromisesLookup.mockResolvedValue([PRIVATE_A] as never);
    await expect(assertSafeUrl("https://rebind.example.com/")).rejects.toThrow(/resolves to a private address/);
  });

  it("rejects when ANY resolved address is private (mixed answer)", async () => {
    mockedPromisesLookup.mockResolvedValue([PUBLIC_A, PRIVATE_A] as never);
    await expect(assertSafeUrl("https://mixed.example.com/")).rejects.toThrow(/resolves to a private address/);
  });

  it("rejects when DNS resolution fails", async () => {
    mockedPromisesLookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeUrl("https://nxdomain.example.com/")).rejects.toThrow(/Could not resolve host/);
  });

  it("passes a normal public HTTPS URL through", async () => {
    mockedPromisesLookup.mockResolvedValue([PUBLIC_A] as never);
    const url = await assertSafeUrl("https://example.com/page?q=1");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("example.com");
    expect(url.toString()).toBe("https://example.com/page?q=1");
  });
});

// ---------------------------------------------------------------------------
// Phase-1 fix: guardedLookup is the connect-time guard wired into the undici
// Agent (connect.lookup). Every address the socket could use must pass
// isPrivateIp at the moment of connection — this is what closes the
// DNS-rebinding window.
// ---------------------------------------------------------------------------
describe("guardedLookup (connect-time SSRF guard)", () => {
  function stubDns(result: LookupAddress[] | Error) {
    mockedCallbackLookup.mockImplementation(((_host: string, _opts: LookupOptions, cb: never) => {
      const callback = cb as (err: Error | null, addresses?: LookupAddress[]) => void;
      if (result instanceof Error) callback(result);
      else callback(null, result);
    }) as never);
  }

  function callGuarded(host: string, options: LookupOptions = {}) {
    return new Promise<{ err: NodeJS.ErrnoException | null; addr: string | LookupAddress[]; family?: number }>(
      (resolve) => {
        guardedLookup(host, options, (err, addr, family) => resolve({ err, addr, family }));
      },
    );
  }

  it("blocks a hostname resolving to a private address at connection time", async () => {
    stubDns([PRIVATE_A]);
    const { err } = await callGuarded("rebind.example.com");
    expect(err?.message).toMatch(/resolves to a private address/);
  });

  it("blocks when ANY candidate address is private (rebinding via mixed answer)", async () => {
    stubDns([PUBLIC_A, PRIVATE_A]);
    const { err } = await callGuarded("mixed.example.com");
    expect(err?.message).toMatch(/resolves to a private address/);
  });

  it("blocks link-local metadata addresses", async () => {
    stubDns([{ address: "169.254.169.254", family: 4 }]);
    const { err } = await callGuarded("metadata.example.com");
    expect(err?.message).toMatch(/resolves to a private address/);
  });

  it("blocks v4-mapped-v6 private addresses", async () => {
    stubDns([{ address: "::ffff:192.168.0.10", family: 6 }]);
    const { err } = await callGuarded("mapped.example.com");
    expect(err?.message).toMatch(/resolves to a private address/);
  });

  it("always resolves with all:true underneath, so no address escapes the check", async () => {
    stubDns([PUBLIC_A]);
    await callGuarded("example.com", { all: false });
    expect(mockedCallbackLookup).toHaveBeenCalledWith(
      "example.com",
      expect.objectContaining({ all: true, verbatim: true }),
      expect.any(Function),
    );
  });

  it("passes a public host through, single-address shape when all is not set", async () => {
    stubDns([PUBLIC_A]);
    const { err, addr, family } = await callGuarded("example.com");
    expect(err).toBeNull();
    expect(addr).toBe(PUBLIC_A.address);
    expect(family).toBe(4);
  });

  it("passes a public host through, array shape when the caller asked for all", async () => {
    const second: LookupAddress = { address: "1.1.1.1", family: 4 };
    stubDns([PUBLIC_A, second]);
    const { err, addr } = await callGuarded("example.com", { all: true });
    expect(err).toBeNull();
    expect(addr).toEqual([PUBLIC_A, second]);
  });

  it("errors on an empty DNS answer", async () => {
    stubDns([]);
    const { err } = await callGuarded("empty.example.com");
    expect(err?.message).toMatch(/Could not resolve host/);
  });

  it("propagates DNS errors", async () => {
    stubDns(new Error("ENOTFOUND"));
    const { err } = await callGuarded("nxdomain.example.com");
    expect(err?.message).toBe("ENOTFOUND");
  });
});
