import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log("--- messages ---");
for (const m of d.messages) {
  if (m.role === "assistant") {
    for (const b of m.content) {
      if (b.type === "text") console.log("ASSISTANT:", b.text.slice(0, 500));
      else console.log("TOOLCALL:", b.name, JSON.stringify(b.arguments));
    }
  } else if (m.role === "toolResult") {
    console.log("TOOLRESULT:", m.content[0].text.slice(0, 200).replace(/\n/g, " | "), "isError=", m.isError);
  } else {
    console.log("USER:", m.content[0].text.slice(0, 120));
  }
}
console.log("--- events ---");
for (const e of d.events) console.log(" ", e.type, e.toolName ?? e.turn ?? "");
