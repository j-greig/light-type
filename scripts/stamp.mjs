// Sets the build stamp (UTC date and time) in public/app.js and public/sw.js. A new stamp makes phones
// install the new service worker; the app then reloads itself when idle. Runs before `npm run deploy`.
import { readFileSync, writeFileSync } from "node:fs";
const d = new Date(), p = (n) => String(n).padStart(2, "0");
const stamp = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
for (const [file, re, name] of [["public/app.js", /const BUILD = '[^']*'/, "BUILD"], ["public/sw.js", /const VERSION = '[^']*'/, "VERSION"]]) {
  const s = readFileSync(file, "utf8");
  if (!re.test(s)) { console.error(`no ${name} in ${file}`); process.exit(1); }
  writeFileSync(file, s.replace(re, `const ${name} = '${stamp}'`));
}
console.log("build " + stamp);
