/** Build T123 fragments and an asset hosting directory; never publishes anything. */
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function httpsURL(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error(label + ': use an HTTPS address without credentials, query or fragment.');
  return url.href;
}
export async function buildTilda(options = {}) {
const configured = !!options['--assets-base'];
const base = httpsURL(options['--assets-base'] || 'https://configure-assets-host.invalid/itd/', 'Asset host').replace(/\/?$/, '/');
const endpoint = options['--form-endpoint'] ? httpsURL(options['--form-endpoint'], 'Forms endpoint') : '';
if (endpoint && /(^|\.)(make|integromat)\.com$/i.test(new URL(endpoint).hostname))
  throw new Error('Use the public relay API, not a secret Make webhook.');
const output = resolve(options['--output'] || join(source, 'tilda', 'generated'));
const pathWithin = (parent, child) => { const p = relative(parent, child); return !p || (!p.startsWith('..') && !isAbsolute(p)); };
if (pathWithin(output, source) || (pathWithin(source, output) && !pathWithin(join(source, 'tilda', 'generated'), output))) throw Error('Use a separate output directory or tilda/generated only.');
try {
  const entries = await readdir(output);
  if (entries.length && !entries.includes('BUILD-STATUS.json')) throw Error('Output directory is not an existing Tilda build. Choose an empty directory.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const pub = join(output, 'public');
await mkdir(pub, { recursive: true });
await cp(join(source, 'assets'), join(pub, 'assets'), { recursive: true, force: true });
const read = (file) => readFile(join(source, file), 'utf8');
// The original app uses assets/... in HTML, CSS url(...) and JS catalog strings.
const rewrite = (text) => text
  .replace(/(["'(`=\s])(?:\.\/)?assets\//g, (_, prefix) => prefix + base + 'assets/')
  .replace(/(["'])index\.html(?=[#"'])/g, '$1/')
  .replace(/(["'])anketa\.html(?=[#"'])/g, '$1/anketa');
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const assetTag = (name) => htmlEscape(base + name);

for (const name of ['site.css', 'project-data.js', 'site.js', 'form-client.js'])
  await writeFile(join(pub, name), rewrite(await read(name)));
await writeFile(join(pub, 'forms-config.js'), '// Public relay address only; no Make secret belongs here.\nwindow.ITD_FORMS_ENDPOINT = ' + JSON.stringify(endpoint) + ';\n');

const metadata = {};
for (const [file, label] of [['index.html', 'home'], ['anketa.html', 'anketa']]) {
  const document = await read(file);
  const head = document.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] || '';
  let body = document.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body) throw new Error('Missing body: ' + file);
  // Preserve the exact original picture bytes; only change how they are delivered.
  let imageNo = 0;
  for (const match of [...body.matchAll(/src="data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)"/g)]) {
    const asset = `assets/tilda-${label}-embedded-${++imageNo}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
    await writeFile(join(pub, asset), Buffer.from(match[2], 'base64'));
    body = body.replace(match[0], `src="${assetTag(asset)}"`);
  }
  const styles = [...head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
  let links = [...head.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).filter(tag => /rel=["']stylesheet["']/.test(tag)).map(tag => tag.replace(/href="([^\"]+)"/, (_, href) => `href="${/^https:\/\//.test(href) ? htmlEscape(href.replace(/&amp;/g, '&')) : assetTag(href)}"`));
  if (styles.length) {
    await writeFile(join(pub, label + '.css'), rewrite(styles.join('\n')));
    links.push(`<link rel="stylesheet" href="${assetTag(label + '.css')}">`);
  }
  // Ordered classic scripts at the end run only after the complete form DOM exists.
  const scripts = [...head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let bodyScriptNo = 0;
  body = body.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attributes, code) => {
    scripts.push([_, attributes, code]); return '';
  });
  const scriptTags = [];
  for (const [, attrs, code] of scripts) {
    const src = attrs.match(/src=["']([^"']+)["']/)?.[1];
    if (src) {
      if (/^https?:/.test(src)) throw Error('Unexpected external script in source');
      scriptTags.push(`<script src="${assetTag(src)}"></script>`);
    } else if (code.trim()) {
      const scriptName = `${label}-inline-${++bodyScriptNo}.js`;
      await writeFile(join(pub, scriptName), rewrite(code));
      scriptTags.push(`<script src="${assetTag(scriptName)}"></script>`);
    }
  }
  const note = configured ? 'ITD Studio: paste this fragment into one T123 block.' : 'TEMPLATE ONLY: configure HTTPS asset hosting and rebuild before publishing.';
  const fragment = `<!-- ${note} -->\n${links.join('\n')}\n${rewrite(body).trim()}\n${scriptTags.join('\n')}\n`;
  await writeFile(join(output, label === 'home' ? 'T123-HOME.html' : 'T123-ANKETA.html'), fragment);
  const title = head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'ITD Studio';
  const desc = head.match(/<meta name="description" content="([^"]*)"/i)?.[1] || '';
  metadata[label] = { page: label === 'home' ? '/' : '/anketa', title, description: desc, fragmentBytes: Buffer.byteLength(fragment) };
  // Inspection page; asset URLs still point to the configured hosting address.
  await writeFile(join(output, `${label}-preview.html`), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body>${fragment}</body></html>`);
}
await writeFile(join(output, 'BUILD-STATUS.json'), JSON.stringify({ readyForPublication: configured && !!endpoint, assetsConfigured: configured, formsConfigured: !!endpoint, pages: metadata }, null, 2) + '\n');
await writeFile(join(output, 'НЕ-ПУБЛИКОВАТЬ-БЕЗ-НАСТРОЙКИ.txt'), 'Публикация не выполнялась. Перед использованием вставок настройте настоящий HTTPS-адрес файлов и серверный обработчик Make, затем пересоберите комплект. Даже BUILD-STATUS.readyForPublication=true означает только заполненность адресов; реальную доставку в Make, Sheets и Telegram нужно проверить отдельно.\n');
console.log(`Tilda files prepared (${configured ? 'asset address configured' : 'TEMPLATES, asset address missing'}; ${endpoint ? 'relay address configured' : 'forms disabled'}).`);
console.log(output);

return { output, metadata };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--assets-base', '--form-endpoint', '--output'].includes(args[i]) || !args[i + 1])
    throw new Error('Use --assets-base HTTPS_URL [--form-endpoint HTTPS_URL] [--output DIRECTORY]');
  options[args[i]] = args[i + 1];
}
await buildTilda(options);
}
