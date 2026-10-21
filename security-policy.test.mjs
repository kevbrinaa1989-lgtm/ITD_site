import test from "node:test";
import assert from "node:assert/strict";
import { createSecurityPolicy } from "./security-policy.mjs";
import {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
} from "./passwords.mjs";
const mock = (headers = {}, remoteAddress = "127.0.0.1") => ({
  headers,
  socket: { remoteAddress },
});
const response = () => ({
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
});
const valid = {
  host: "cabinet.example.test",
  "x-forwarded-proto": "https",
  "x-real-ip": "198.51.100.8",
};
test("internet policy requires a single exact HTTPS origin and cannot disable Secure cookies", () => {
  for (const publicOrigin of [
    undefined,
    "http://cabinet.example.test",
    "https://cabinet.example.test/",
    "https://cabinet.example.test/path",
    "https://u:p@cabinet.example.test",
  ])
    assert.throws(() =>
      createSecurityPolicy({ internetMode: true, publicOrigin }),
    );
  const policy = createSecurityPolicy({
    internetMode: true,
    publicOrigin: "https://cabinet.example.test",
    secureCookies: false,
  });
  assert.equal(policy.secureCookies, true);
  assert.equal(policy.registrationAllowed, false);
  const req = mock({ ...valid, "x-forwarded-for": "1.2.3.4" }),
    res = response();
  policy.apply(req, res);
  assert.equal(req.itdClientIP, "198.51.100.8");
  assert.match(res.headers["Strict-Transport-Security"], /max-age/);
  for (const req of [
    mock({ ...valid, host: "attacker.example" }),
    mock({ ...valid, "x-forwarded-proto": "http" }),
    mock({ ...valid, "x-real-ip": "198.51.100.8, 1.2.3.4" }),
    mock({ ...valid, origin: "https://evil.example" }),
    mock(valid, "198.51.100.90"),
  ])
    assert.throws(
      () => policy.apply(req, response()),
      (e) => e.status === 403,
    );
  assert.equal(
    policy.validOrigin(
      mock({ ...valid, origin: "https://cabinet.example.test" }),
    ),
    true,
  );
  assert.equal(policy.validOrigin(mock(valid)), false);
});
test("local mode preserves HTTP behavior and ignores forwarded addresses from arbitrary callers", () => {
  const policy = createSecurityPolicy({ internetMode: false });
  const req = mock(
    { "x-real-ip": "198.51.100.99", "x-forwarded-for": "9.9.9.9" },
    "127.0.0.1",
  );
  policy.apply(req, response());
  assert.equal(req.itdClientIP, "127.0.0.1");
  assert.equal(policy.secureCookies, false);
  assert.equal(policy.registrationAllowed, true);
});
test("asynchronous scrypt accepts existing salted hashes and bounds work instead of blocking the event loop", async () => {
  const password = "Legacy-compatible-secret";
  const old = hashPasswordSync(password);
  assert.match(old, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal(await verifyPassword(password, old), true);
  assert.equal(await verifyPassword("wrong", old), false);
  assert.equal(await verifyPassword(password, "invalidhash"), false);
  const fresh = await hashPassword(password);
  assert.equal(await verifyPassword(password, fresh), true);
  const jobs = Array.from({ length: 37 }, () => verifyPassword(password, old));
  let eventLoopRan = false;
  setImmediate(() => {
    eventLoopRan = true;
  });
  const results = await Promise.allSettled(jobs);
  assert.ok(eventLoopRan);
  assert.ok(
    results.some((r) => r.status === "rejected" && r.reason.status === 503),
  );
  assert.ok(
    results
      .filter((r) => r.status === "fulfilled")
      .every((r) => r.value === true),
  );
});
