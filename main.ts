// Launch Radar v5: a token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed snapshot, fits the two-stage model in lib/model.ts on
// the snapshot's own protocols (launch odds from the peer record, launch
// value from the priced comparables, every term kept only if it survives
// two held-out tests), ranks 200 pre-token protocols by implied value,
// and writes /output/board.json. The dashboard/ and screenshots/ folders
// are copied across, data.js carries the same board to the page, and
// /output/dossier.json is written last with the vendored make.fun
// library, byte for byte as the scorer rebuilds it.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { auditBoard, auditCourt } from './lib/audit.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch radar v5: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar v5: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
// Double-entry audit: lib/audit.ts re-derives the whole board from
// the snapshot by a second, independent path. A build that cannot
// reproduce itself does not ship.
const audit = auditBoard(snapshot, radar);
if (audit.ranks_identical !== audit.rows_checked) {
  process.stderr.write(`launch radar v5: audit failed — the second path reproduces ${audit.ranks_identical} of ${audit.rows_checked} ranks\n`);
  process.exit(1);
}
process.stdout.write(`launch radar v5: audit passed — ${audit.ranks_identical} of ${audit.rows_checked} ranks reproduced by the second path, largest implied drift ${(audit.max_drift * 100).toFixed(3)}%, watchlist ${audit.watchlist_covered} of ${snapshot.watchlist.length}\n`);
// The same second path re-derives the court's four headline
// scores — the numbers the dashboard's first screen leads with.
// A disagreement past float noise means one of the two
// implementations is wrong, and the build does not ship.
const court = auditCourt(snapshot, radar);
const courtWorst = Math.max(court.cv_diff, court.ts_diff, court.loo_diff, court.wf_diff);
if (courtWorst > 0.01) {
  process.stderr.write(`launch radar v5: court audit failed — headline scores disagree with the second path (worst difference ${courtWorst.toFixed(4)})\n`);
  process.exit(1);
}
process.stdout.write(`launch radar v5: court audit passed — ten-fold Brier ${court.cv.toFixed(3)}, time split ${court.ts.toFixed(3)}, leave-one-out x${court.loo.toFixed(2)}, walk-forward x${court.wf.toFixed(2)}, all re-derived by the second path\n`);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));
// The raw snapshot ships too: the dashboard refits both model stages
// from it, in the reader's browser, and diffs the result against the
// board above — the page does not have to take the build's word for it.
writeFileSync(join(out, 'snapshot.js'), `window.SNAPSHOT = ${JSON.stringify(snapshot)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const pageFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launch radar v5: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, the evidence and a detail view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch radar v5: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `launch radar v5: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked, all ${snapshot.watchlist.length} watchlist slugs covered\n` +
    `launch radar v5: odds terms [${radar.odds.terms.join(', ')}], ten-fold Brier ${radar.odds.final_cv.toFixed(3)} against a ${radar.odds.base_rate.toFixed(3)} base rate; value terms [${radar.value.terms.join(', ')}], leave-one-out miss x${radar.value.final_loo.toFixed(2)} against x${radar.value.flat_miss.toFixed(2)} for the flat multiple\n` +
    `launch radar v5: verdicts ${JSON.stringify(radar.verdicts)}; wrote board.json, data.js, dashboard (${pageFiles.length} files), screenshots (${shots.length} images) and dossier.json\n`,
);
