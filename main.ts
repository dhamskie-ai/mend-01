// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits,
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), line matching at three
// tiers (section 5), and the all-or-nothing write (section 10).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

let STRICT = false;

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = ((tree: Tree) => void) & { move?: { old: string; new: string } };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 3: file line model ----

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---- Section 5: matching lines ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Occurrences of O in `lines` at/after `from`, at the first tier that has any. */
function findOcc(lines: string[], o: string[], from: number): { tier: number; positions: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

interface NEntry { text: string; ctx: boolean; oIndex: number; }

function reindent(line: string, f: string, p: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Resolve N entries against the matched file lines: context lines are the file's own lines, other lines are re-indented at tier 2. */
function resolveN(entries: NEntry[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return entries.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIndex]!;
    if (tier === 2) return reindent(e.text, f, p);
    return e.text;
  });
}

// ---- Section 6: unified diffs ----

interface BodyItem { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string; }
interface UniHunk { a: number; body: BodyItem[]; noNL: boolean; }
interface UniSection {
  old: string | null; new: string | null;
  renameOld?: string | null; renameNew?: string | null;
  creation: boolean; deletion: boolean; hunks: UniHunk[]; hasPair: boolean;
}

function parseUniPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNL(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const it = body[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') {
      return body[i + 1] !== undefined && body[i + 1]!.kind === 'bs';
    }
  }
  return false;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state = 'out'; // 'out' | 'header' | 'section'
  let curHunk: UniHunk | null = null;
  const finishHunk = (): void => {
    if (curHunk === null) return;
    while (curHunk.body.length > 0) {
      const last = curHunk.body[curHunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') curHunk.body.pop();
      else break;
    }
    curHunk.noNL = hunkNoNL(curHunk.body);
    cur!.hunks.push(curHunk);
    curHunk = null;
  };
  const startHunk = (line: string, idx: number): void => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    curHunk = { a: Number(m[1]), body: [], noNL: false };
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
        state = 'section';
        continue;
      }
      if (line === '') { curHunk.body.push({ kind: 'ctx', text: '' }); i++; continue; }
      const c = line[0]!;
      if (c === ' ') { curHunk.body.push({ kind: 'ctx', text: line.slice(1) }); i++; continue; }
      if (c === '-') { curHunk.body.push({ kind: 'del', text: line.slice(1) }); i++; continue; }
      if (c === '+') { curHunk.body.push({ kind: 'add', text: line.slice(1) }); i++; continue; }
      if (c === '\\') { curHunk.body.push({ kind: 'bs', text: line }); i++; continue; }
      finishHunk();
      state = 'section';
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, new: m[2]!, creation: false, deletion: false, hunks: [], hasPair: false };
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null && !cur.hasPair) {
        cur.old = parseUniPath(line);
        cur.new = parseUniPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = { old: parseUniPath(line), new: parseUniPath(lines[i + 1]!), creation: false, deletion: false, hunks: [], hasPair: true };
      sections.push(cur);
      state = 'header';
      i += 2;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
      else if (line.startsWith('@@')) startHunk(line, i);
      i++;
      continue;
    }
    if (state === 'section' && cur !== null) {
      if (line.startsWith('@@')) startHunk(line, i);
      i++;
      continue;
    }
    // state 'out'
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  finishHunk();
  return sections.map((sec) => unifiedEdit(sec));
}

function unifiedEdit(sec: UniSection): Edit {
  const oldP = sec.hasPair ? sec.old : (sec.renameOld !== undefined ? sec.renameOld : sec.old);
  const newP = sec.hasPair ? sec.new : (sec.renameNew !== undefined ? sec.renameNew : sec.new);
  const isCreation = sec.creation || oldP === null;
  const isDeletion = !isCreation && (sec.deletion || newP === null);
  const edit: Edit = (tree) => {
    if (oldP === null && newP === null) return;
    if (isCreation) {
      const np = newP;
      if (np === null) return;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const outLines: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const it = h.body[k]!;
          if (it.kind === 'add') {
            outLines.push(it.text);
            noNL = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'bs';
          }
        }
      }
      tree.now.set(np, outLines.length === 0 ? '' : outLines.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const op = oldP;
      if (op === null) return;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (np !== op && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
    const model = splitFile(before);
    let fileLines = [...model.lines];
    let final = model.final;
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      const nEntries: NEntry[] = [];
      for (const it of h.body) {
        if (it.kind === 'ctx') { o.push(it.text); nEntries.push({ text: it.text, ctx: true, oIndex: o.length - 1 }); }
        else if (it.kind === 'del') { o.push(it.text); }
        else if (it.kind === 'add') { nEntries.push({ text: it.text, ctx: false, oIndex: -1 }); }
      }
      if (o.length > 0) {
        const found = findOcc(fileLines, o, 0);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) { best = p; bestDist = dist; }
        }
        const pos = best;
        const reachesEnd = pos + o.length === fileLines.length;
        const resolved = resolveN(nEntries, fileLines, pos, found.tier, o);
        fileLines.splice(pos, o.length, ...resolved);
        if (reachesEnd) final = !h.noNL;
        d += nEntries.length - o.length;
      } else {
        const insertPos = Math.min(Math.max(h.a + d, 0), fileLines.length);
        const reachesEnd = insertPos === fileLines.length;
        const resolved = nEntries.map((e) => e.text);
        fileLines.splice(insertPos, 0, ...resolved);
        if (reachesEnd) final = !h.noNL;
        d += nEntries.length;
      }
    }
    const result = joinFile(fileLines, model.br, final);
    if (np !== op) {
      tree.now.set(np, result);
      tree.now.set(op, null);
    } else {
      tree.now.set(op, result);
    }
  };
  if (oldP !== null && newP !== null && oldP !== newP && !isCreation && !isDeletion) edit.move = { old: oldP, new: newP };
  return edit;
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findOcc(model.lines, oldLines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const entries: NEntry[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const resolved = resolveN(entries, model.lines, pos, found.tier, oldLines);
    const out = [...model.lines];
    out.splice(pos, oldLines.length, ...resolved);
    tree.now.set(path, joinFile(out, model.br, model.final));
  };
}

function srEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let sep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { rep = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(srEdit(path, oldLines, newLines));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk { anchor: string | null; body: BodyItem[]; eof: boolean; }

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, startNo: number, raw: { text: string; no: number }[]): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const rl of raw) {
      if (rl.text === '') fileLines.push('');
      else if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
      else throw new Exit2(`error: parse ${rl.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const rl of raw) {
      if (!blank(rl.text)) throw new Exit2(`error: parse ${rl.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update
  let moveTo: string | null = null;
  let rest = raw;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (const rl of rest) {
    const t = rl.text;
    if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${rl.no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      const k = t === '' ? 'ctx' : t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add';
      cur.body.push({ kind: k, text: t === '' ? '' : t.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${rl.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startNo}`);
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let fileLines = [...model.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findOcc(fileLines, [ch.anchor], cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const o: string[] = [];
      const nEntries: NEntry[] = [];
      for (const it of ch.body) {
        if (it.kind === 'ctx') { o.push(it.text); nEntries.push({ text: it.text, ctx: true, oIndex: o.length - 1 }); }
        else if (it.kind === 'del') { o.push(it.text); }
        else if (it.kind === 'add') { nEntries.push({ text: it.text, ctx: false, oIndex: -1 }); }
      }
      if (ch.eof) {
        if (o.length === 0) {
          const resolved = nEntries.map((e) => e.text);
          fileLines.splice(fileLines.length, 0, ...resolved);
          cursor = fileLines.length;
        } else {
          const found = findOcc(fileLines, o, cursor);
          if (found === null) throw new Fail('no-match', path);
          const pos = found.positions.find((p) => p + o.length === fileLines.length);
          if (pos === undefined) throw new Fail('no-match', path);
          const resolved = resolveN(nEntries, fileLines, pos, found.tier, o);
          fileLines.splice(pos, o.length, ...resolved);
          cursor = pos + resolved.length;
        }
      } else if (o.length === 0) {
        const resolved = nEntries.map((e) => e.text);
        fileLines.splice(cursor, 0, ...resolved);
        cursor += resolved.length;
      } else {
        const found = findOcc(fileLines, o, cursor);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const resolved = resolveN(nEntries, fileLines, pos, found.tier, o);
        fileLines.splice(pos, o.length, ...resolved);
        cursor = pos + resolved.length;
      }
    }
    const result = joinFile(fileLines, model.br, model.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, result);
    }
  };
  if (moveTo !== null) edit.move = { old: path, new: moveTo };
  return edit;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; path = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; path = line.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const startNo = i + 1;
    const raw: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aEdit(kind, path, startNo, raw));
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  STRICT = strict;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? srEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      if (edit.move !== undefined) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const rowList: { key: string; line: string }[] = [];
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.new);
    const nowOld = tree.get(m.old);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rowList.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      consumed.add(m.old);
      consumed.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
