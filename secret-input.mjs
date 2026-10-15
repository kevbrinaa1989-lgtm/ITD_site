import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";

// Raw terminal mode disables terminal echo. Passwords never enter command history.
export function readSecret(question, input = stdin, output = stdout) {
  if (!input.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(Error("Для скрытого ввода откройте ПЕРВЫЙ-ЗАПУСК.cmd в обычном окне Windows. Ввод пароля из файла запрещён."));
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = !!input.isRaw;
    const finish = (error) => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      const result = value;
      value = "";
      error ? reject(error) : resolve(result);
    };
    const onEnd = () => finish(Error("Ввод отменён. База не создана."));
    const onError = () => finish(Error("Не удалось прочитать пароль. База не создана."));
    const onKey = (text, key = {}) => {
      if (key.ctrl && ["c", "d"].includes(key.name)) return onEnd();
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = Array.from(value).slice(0, -1).join(""); return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    output.write(question);
    input.resume();
  });
}
