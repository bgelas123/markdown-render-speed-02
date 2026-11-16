// Driver for the markdown-render-speed entry: renders every case in
// /input/cases.json with parse() from ./parse.js and writes the HTML
// strings, in the same order, to /output/html.json. Run with node 22.
// (Outside a container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override
// the default /input and /output directories.)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) rendered[i] = parse(cases[i].markdown);
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
