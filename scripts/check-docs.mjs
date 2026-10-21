#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const files = ['README.md'];
for (const name of await readdir(join(root, 'docs'))) {
  if (name.endsWith('.md')) files.push(join('docs', name));
}

const slug = (heading) => heading
  .toLowerCase()
  .replace(/[`*_]/gu, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .trim()
  .replace(/\s+/gu, '-');

const headings = new Map();
for (const file of files) {
  const text = await readFile(join(root, file), 'utf8');
  headings.set(resolve(root, file), new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => slug(match[1])),
  ));
}

const problems = [];
for (const file of files) {
  const text = await readFile(join(root, file), 'utf8');
  if ([...text.matchAll(/^```/gmu)].length % 2 !== 0) problems.push(`${file}: unbalanced code fence`);

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/u.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const resolved = resolve(dirname(join(root, file)), pathPart);
    try {
      await stat(resolved);
    } catch {
      problems.push(`${file}: missing link target ${target}`);
      continue;
    }
    if (anchor !== undefined) {
      const known = headings.get(resolved);
      if (known !== undefined && !known.has(anchor)) {
        problems.push(`${file}: missing anchor #${anchor} in ${pathPart}`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`docs OK: ${files.length} files`);
