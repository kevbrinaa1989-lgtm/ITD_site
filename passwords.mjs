import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
let active = 0;
const queue = [];
function derive(password, salt) {
  return new Promise((resolve, reject) => {
    const work = () => {
      active++;
      scrypt(password, salt, 64, (error, key) => {
        active--;
        queue.shift()?.();
        error ? reject(error) : resolve(key);
      });
    };
    if (active < 4) work();
    else if (queue.length < 32) queue.push(work);
    else
      reject(
        Object.assign(
          new Error("Сервер занят проверкой паролей. Повторите через минуту."),
          { status: 503 },
        ),
      );
  });
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export function hashPasswordSync(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  const valid =
    typeof stored === "string" && /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored);
  const [salt, digest] = (
    valid ? stored : `${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  return (
    timingSafeEqual(await derive(password, salt), Buffer.from(digest, "hex")) &&
    valid
  );
}
