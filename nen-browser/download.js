import { byteRange } from '../app/electron/rules';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const directory = resolve(process.env.NEN_DOWNLOAD_DIR || '.local/downloads');
const metadata = join(directory, 'installer.json');
let current, pending, nextCheck = 0;
const ready = readFile(metadata, 'utf8').then(async text => {
  const saved = JSON.parse(text);
  if (!/^[a-f0-9]{64}$/.test(saved.hash) || !Number.isSafeInteger(saved.size)) return;
  if ((await stat(join(directory, saved.hash + '.exe'))).size === saved.size) current = saved;
}).catch(() => {});

async function refresh() {
  const response = await fetch('https://api.github.com/repos/may-be-gay/Nen/releases/tags/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Nen' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`Installer check: HTTP ${response.status}`);
  const release = await response.json();
  const asset = release.assets?.find(a => a.name === 'Nen-Setup.exe');
  if (!asset || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 1024 || asset.size > 1073741824
    || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || asset.browser_download_url !== 'https://github.com/may-be-gay/Nen/releases/download/latest/Nen-Setup.exe') throw Error('Invalid installer metadata');
  const hash = asset.digest.slice(7);
  if (current?.hash === hash) return;
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, hash + '.part');
  try {
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600000) });
    if (!download.ok || !download.body) throw Error('Installer download failed');
    let size = 0;
    const checksum = createHash('sha256');
    await pipeline(Readable.fromWeb(download.body), new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > asset.size) return callback(Error('Installer too large'));
      checksum.update(chunk); callback(null, chunk);
    }}), createWriteStream(temporary));
    if (size !== asset.size || checksum.digest('hex') !== hash) throw Error('Installer checksum mismatch');
    await rename(temporary, join(directory, hash + '.exe'));
    const saved = { hash, size, assetId: asset.id, updatedAt: asset.updated_at };
    await writeFile(metadata + '.tmp', JSON.stringify(saved));
    await rename(metadata + '.tmp', metadata);
    const old = current; current = saved;
    if (old && old.hash !== hash) await rm(join(directory, old.hash + '.exe'), { force: true }).catch(() => {});
    console.info('Installer cached:', asset.id);
  } finally { await rm(temporary, { force: true }); }
}

export async function downloadInstaller(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  await ready;
  if (!pending && Date.now() >= nextCheck) {
    nextCheck = Date.now() + 300000;
    pending = refresh().catch(error => console.error(error.message)).finally(() => { pending = undefined; });
  }
  if (!current) await pending;
  if (!current) { res.writeHead(503, { 'Retry-After': '300', 'Cache-Control': 'no-store' }).end('Installer unavailable. Please try again later.'); return; }
  const saved = current;
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Nen-Setup.exe"',
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ETag: '"' + saved.hash + '"', 'Accept-Ranges': 'bytes' };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers).end(); return; }
  const range = byteRange(!req.headers['if-range'] || req.headers['if-range'] === headers.ETag ? req.headers.range : undefined, saved.size);
  if (!range) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${saved.size}` }).end(); return; }
  const { start, end, partial } = range;
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${saved.size}`;
  res.writeHead(partial ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') { res.end(); return; }
  try { await pipeline(createReadStream(join(directory, saved.hash + '.exe'), { start, end }), res); }
  catch { res.destroy(); }
}
