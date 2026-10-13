'use strict';
const path = require('path');

const EXT = {
  images: 'jpg jpeg png gif bmp webp svg heic heif tif tiff ico raw cr2 nef arw dng psd',
  videos: 'mp4 mkv mov avi wmv flv webm m4v mpg mpeg 3gp mts',
  audio: 'mp3 wav flac aac m4a ogg wma opus',
  documents: 'pdf doc docx xls xlsx ppt pptx txt md csv rtf odt ods odp',
  archives: 'zip rar 7z tar gz tgz bz2 xz',
  installers: 'exe msi iso dmg',
};
const EXT_MAP = new Map();
for (const [cat, list] of Object.entries(EXT)) for (const e of list.split(' ')) EXT_MAP.set(e, cat);

const CATEGORY_DIR = {
  projects: 'Projects', images: 'Images', videos: 'Videos', audio: 'Audio',
  documents: 'Documents', archives: 'Archives', installers: 'Installers', other: 'Other',
};
const TABS = ['projects', 'images', 'videos', 'documents', 'audio', 'archives', 'installers', 'other'];

function extOf(name) {
  const e = path.extname(name).slice(1).toLowerCase();
  return e;
}
function categoryOf(ext) {
  return EXT_MAP.get(ext) || 'other';
}

const PROJECT_FILES = new Set([
  '.git', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt',
  'pyproject.toml', 'setup.py', 'go.mod', 'cargo.toml', 'composer.json', 'pubspec.yaml', 'angular.json',
]);
function isProjectRoot(names) {
  for (const n of names) {
    const l = n.toLowerCase();
    if (PROJECT_FILES.has(l) || l.endsWith('.csproj') || l.endsWith('.sln')) return true;
  }
  return false;
}

function detectStack(names) {
  const l = new Set(names.map((n) => n.toLowerCase()));
  const has = (x) => l.has(x);
  const any = (suffix) => [...l].some((n) => n.endsWith(suffix));
  const s = [];
  if (has('angular.json')) s.push('Angular');
  if (has('package.json')) s.push('Node');
  if (any('next.config.js') || any('next.config.mjs') || any('next.config.ts')) s.push('Next.js');
  if (has('pom.xml')) s.push('Maven');
  if (has('build.gradle') || has('build.gradle.kts')) s.push('Gradle');
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) s.push('Python');
  if (any('.csproj') || any('.sln')) s.push('.NET');
  if (has('go.mod')) s.push('Go');
  if (has('cargo.toml')) s.push('Rust');
  if (has('composer.json')) s.push('PHP');
  if (has('pubspec.yaml')) s.push('Flutter');
  if (!s.length && has('.git')) s.push('Git');
  return s.join(' + ');
}

const DEFAULT_REGEN = [
  'node_modules', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', '__pycache__', '.pytest_cache',
  '.venv', 'venv', '.gradle', 'dist', 'build', 'out', 'coverage', 'obj', 'target', 'bin',
];
/** Names that only count as regenerable when a build-system file sits next to them. */
const CONDITIONAL_REGEN = new Set(['target', 'bin']);

function conditionalOk(names) {
  for (const n of names) {
    const l = n.toLowerCase();
    if (l === 'cargo.toml' || l === 'pom.xml' || l.endsWith('.csproj')) return true;
  }
  return false;
}

/** Is directory `name` (a child of a dir whose entries are `siblingNames`) regenerable? */
function isRegenDir(name, regenSet, siblingNames, ci) {
  const n = ci ? name.toLowerCase() : name;
  if (!regenSet.has(n)) return false;
  if (CONDITIONAL_REGEN.has(n.toLowerCase())) return conditionalOk(siblingNames);
  return true;
}

function makeRegenSet(list, ci) {
  return new Set(list.map((x) => (ci ? x.toLowerCase() : x)));
}

module.exports = {
  categoryOf, extOf, isProjectRoot, detectStack, DEFAULT_REGEN, CONDITIONAL_REGEN,
  isRegenDir, makeRegenSet, CATEGORY_DIR, TABS, conditionalOk,
};
