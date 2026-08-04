// Uploads the built tournament pages to S3. `npm run publish -- --confirm`
//
// The pages are build artifacts. `runs/` is gitignored, so they live only on
// the machine that produced them and this is how they reach the web.
//
// THE BUCKET NAME IS NOT IN THIS FILE ON PURPOSE. This repo is public. Pass
// --bucket, or set POLIS_PUBLISH_BUCKET.
//
// HAZARD, read before first use. The website deploy runs
//   aws s3 sync <hugo public/> s3://<same bucket> --delete
// on every website push. `--delete` removes objects the source does not
// contain, and Hugo does not build these files, so the next website deploy
// removes them. The website CI must carry `--exclude "polis/*"` BEFORE anything
// is uploaded here. AWS documents that an --exclude pattern also protects
// matching objects in the target from deletion. Nothing warns you if it is
// missing; the first symptom is a dead link.
//
// Agent AWS access is read-only, so this is run by a human with write
// credentials.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const bucket = arg('bucket', process.env.POLIS_PUBLISH_BUCKET ?? '');
const profile = arg('profile', process.env.POLIS_PUBLISH_PROFILE ?? '');
const region = arg('region', 'ca-central-1');
const prefix = arg('prefix', 'polis');
const confirm = has('confirm');

if (!bucket) {
  console.error('No bucket. Pass --bucket <name> or set POLIS_PUBLISH_BUCKET.');
  process.exit(1);
}

// What gets published, and where it lands. Keep these paths stable: the repo
// and the blog post point at them, and #25 asks for stable URLs.
const FILES = [
  { local: 'runs/tournament-main/highlights.html', key: 'tournament-1/highlights.html' },
  { local: 'runs/tournament-main/chronicle.html', key: 'tournament-1/chronicle.html' },
  { local: 'runs/t2-full/highlights.html', key: 'tournament-2/highlights.html' },
  { local: 'runs/t2-full/chronicle.html', key: 'tournament-2/chronicle.html' },
];

const repoRoot = path.resolve(import.meta.dirname, '..');
let missing = 0;
const plan = FILES.map((f) => {
  const abs = path.join(repoRoot, f.local);
  const exists = fs.existsSync(abs);
  if (!exists) missing++;
  return { ...f, abs, exists, size: exists ? fs.statSync(abs).size : 0 };
});

console.log(`bucket   s3://${bucket}/${prefix}/`);
console.log(`region   ${region}${profile ? `\nprofile  ${profile}` : ''}`);
console.log('');
for (const p of plan) {
  const kb = (p.size / 1024).toFixed(0).padStart(6);
  console.log(`  ${p.exists ? 'ok     ' : 'MISSING'} ${kb} KB  ${p.local}  ->  ${prefix}/${p.key}`);
}
console.log('');

if (missing) {
  console.error(`${missing} file(s) missing. Build them first:`);
  console.error('  npm run chronicle -- runs/<dir>');
  console.error('  npm run highlights -- --dir runs/<dir> --content content/highlights-<t>.yaml');
  process.exit(1);
}

// Best-effort reminder about the delete hazard. The website repo may not be
// checked out next to this one, so a miss here is not an error.
const ciPath = path.resolve(repoRoot, '../website/content/.gitlab-ci.yml');
if (fs.existsSync(ciPath)) {
  const ci = fs.readFileSync(ciPath, 'utf8');
  const guarded = new RegExp(`--exclude\\s+"?/?${prefix}/\\*`).test(ci);
  console.log(
    guarded
      ? `website CI excludes "${prefix}/*" from --delete. Safe to upload.`
      : `WARNING: website CI does NOT exclude "${prefix}/*" from its --delete sync.\n` +
        `         The next website deploy will remove these files.\n` +
        `         Land that change first.`,
  );
} else {
  console.log(`Could not check the website CI for an "${prefix}/*" exclude (repo not found).`);
  console.log('Confirm that exclude is in place before uploading, or a website deploy deletes these.');
}
console.log('');

if (!confirm) {
  console.log('Dry run. Nothing uploaded. Re-run with --confirm to upload.');
  process.exit(0);
}

for (const p of plan) {
  const args = [
    's3', 'cp', p.abs, `s3://${bucket}/${prefix}/${p.key}`,
    '--content-type', 'text/html; charset=utf-8',
    '--cache-control', 'max-age=300',
    '--region', region,
  ];
  if (profile) args.push('--profile', profile);
  console.log(`uploading ${prefix}/${p.key}`);
  execFileSync('aws', args, { stdio: 'inherit' });
}
console.log(`\nDone. Verify each URL resolves before adding any pointer to it.`);
