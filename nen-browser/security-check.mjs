import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const metadata = JSON.parse(readFileSync('server-meta.json', 'utf8'));
const included = new Set(Object.values(metadata.outputs).flatMap(output => Object.entries(output.inputs).filter(([, info]) => info.bytesInOutput > 0).map(([name]) => name)));
const packages = new Set([...included].flatMap(name => { const match = name.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); return match ? [match[1]] : []; }));
if (packages.has('webtorrent') || packages.has('ip')) throw Error('Desktop torrent dependencies entered the web server bundle.');
// Audit the browser and build tools, then only the root packages shipped in the server bundle.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['audit', '--audit-level=low'], {stdio:'inherit', shell:process.platform === 'win32'});
const audit = spawnSync(npm, ['audit', '--json'], {cwd:'../app', encoding:'utf8', shell:process.platform === 'win32'});
const report = JSON.parse(audit.stdout);
if (!report.metadata || !report.vulnerabilities) throw Error('Root dependency audit did not complete.');
const exposed = Object.keys(report.vulnerabilities).filter(name => packages.has(name));
if (exposed.length) throw Error('Vulnerable website dependencies: ' + exposed.join(', '));
console.log('Website server dependency audit passed:', [...packages].join(', ') || 'Node built-ins only');
