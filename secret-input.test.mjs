import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { readSecret } from "./secret-input.mjs";

function terminal() {
  const input = new PassThrough();
  const modes = [];
  let printed = "";
  input.isTTY = true;
  input.setRawMode = (enabled) => { modes.push(enabled); input.isRaw = enabled; };
  const output = new Writable({ write(chunk, encoding, done) { printed += chunk.toString(); done(); } });
  return { input, output, modes, get printed() { return printed; } };
}

test("secret input hides characters and restores the terminal after confirmation", async () => {
  const tty = terminal(), password = randomBytes(24).toString("hex");
  const pending = readSecret("Password: ", tty.input, tty.output);
  tty.input.write(password + "x\x7f\r");
  assert.equal(await pending, password);
  assert.equal(tty.printed, "Password: \n");
  assert.deepEqual(tty.modes, [true, false]);
  assert.equal(tty.input.listenerCount("keypress"), 0);
  tty.input.destroy();
});

test("secret input cancellation restores the terminal and does not print the password", async () => {
  const tty = terminal(), password = randomBytes(24).toString("hex");
  const pending = readSecret("Password: ", tty.input, tty.output);
  tty.input.write(password + "\x03");
  await assert.rejects(pending, /отменён/);
  assert.equal(tty.printed, "Password: \n");
  assert.deepEqual(tty.modes, [true, false]);
  assert.equal(tty.input.listenerCount("keypress"), 0);
  tty.input.destroy();
});

test("secret input refuses noninteractive input instead of echoing credentials", async () => {
  const input = new PassThrough(), output = new PassThrough();
  await assert.rejects(readSecret("Password: ", input, output), /скрытого ввода/);
  assert.equal(output.readableLength, 0);
  input.destroy(); output.destroy();
});
