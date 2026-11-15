import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpFetch } from "../src/core/http";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/stall") {
      // Headers and a first chunk arrive, then the body never finishes.
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("partial");
      return;
    }
    if (request.url === "/start") {
      response.writeHead(302, { Location: "/landed" });
      response.end();
      return;
    }
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Set-Cookie": ["first=1; Path=/", "second=2; Path=/"],
    });
    response.end("landed body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("httpFetch", () => {
  it("keeps the final URL, cookies and body of a redirected response", async () => {
    const response = await httpFetch(`${baseUrl}/start`, { timeoutMs: 5000 });
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${baseUrl}/landed`);
    expect(response.redirected).toBe(true);
    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"]);
    expect(await response.text()).toBe("landed body");
  });

  it("returns redirects untouched when asked not to follow them", async () => {
    const response = await httpFetch(`${baseUrl}/start`, { redirect: "manual", timeoutMs: 5000 });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/landed");
  });

  it("handles responses that cannot carry a body", async () => {
    const response = await httpFetch(`${baseUrl}/empty`, { timeoutMs: 5000 });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("times out when the body stalls after the headers arrive", async () => {
    const started = Date.now();
    await expect(httpFetch(`${baseUrl}/stall`, { timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
