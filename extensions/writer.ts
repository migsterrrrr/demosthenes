/**
 * /write — minimalist writing mode inspired by iA Writer
 * /write → picker, /write new → fresh entry, /write <name> → open file
 * ESC save+close, Ctrl+S save, Ctrl+G focus mode, Ctrl+/ help
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, Container, Text, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const JOURNAL = process.env.WRITER_DIR || join(process.env.HOME!, "journal");
const W = 72, PAD = 5;
const DIM = "\x1b[90m", BOLD = "\x1b[1m", REV = "\x1b[7m", R = "\x1b[0m";

function wrap(text: string, w: number): { text: string; start: number }[] {
	if (text.length <= w) return [{ text, start: 0 }];
	const segs: { text: string; start: number }[] = [];
	let pos = 0;
	while (pos < text.length) {
		if (text.length - pos <= w) { segs.push({ text: text.slice(pos), start: pos }); break; }
		let br = text.lastIndexOf(" ", pos + w);
		if (br <= pos) br = pos + w;
		segs.push({ text: text.slice(pos, br), start: pos });
		pos = br + (text[br] === " " ? 1 : 0);
	}
	return segs.length ? segs : [{ text: "", start: 0 }];
}

class Writer {
	private ln: string[];
	private cur = { l: 0, c: 0 };
	private scroll = 0;
	private focus = true;
	private dirty = false;
	private undos: { ln: string[]; l: number; c: number }[] = [];
	private batch = 0;
	private path: string;
	private name: string;
	private tui: any;
	private done: () => void;
	private ver = 0;
	private cv = -1;
	private cw = 0;
	private cl: string[] = [];
	private saved = 0;
	private help = false;
	private t0 = Date.now();
	private tick: any;

	constructor(tui: any, path: string, name: string, content: string, done: () => void) {
		this.tui = tui; this.path = path; this.name = name; this.done = done;
		this.ln = content.length > 0 ? content.split("\n") : [""];
		this.cur.l = this.ln.length - 1;
		this.cur.c = this.ln[this.cur.l].length;
		this.snap();
		this.tick = setInterval(() => { this.ver++; this.tui.requestRender(); }, 1000);
	}

	private snap() {
		this.undos.push({ ln: [...this.ln], l: this.cur.l, c: this.cur.c });
		if (this.undos.length > 300) this.undos.shift();
	}

	private mod(fn: () => void) { this.snap(); fn(); this.dirty = true; }

	private undo() {
		if (this.undos.length <= 1) return;
		this.undos.pop();
		const s = this.undos.at(-1)!;
		this.ln = [...s.ln]; this.cur.l = s.l; this.cur.c = s.c; this.dirty = true;
	}

	private vlines(w: number) {
		const out: { ll: number; sc: number; t: string }[] = [];
		for (let i = 0; i < this.ln.length; i++)
			if (!this.ln[i].length) out.push({ ll: i, sc: 0, t: "" });
			else for (const s of wrap(this.ln[i], w)) out.push({ ll: i, sc: s.start, t: s.text });
		return out;
	}

	private vcursor(vls: { ll: number; sc: number; t: string }[]) {
		for (let i = 0; i < vls.length; i++) {
			if (vls[i].ll !== this.cur.l) continue;
			const nx = vls[i + 1];
			const end = nx && nx.ll === this.cur.l ? nx.sc : this.ln[this.cur.l].length + 1;
			if (this.cur.c >= vls[i].sc && this.cur.c < end)
				return { vi: i, vc: Math.min(this.cur.c - vls[i].sc, vls[i].t.length) };
		}
		return { vi: vls.length - 1, vc: 0 };
	}

	private para(): { s: number; e: number } | null {
		if (!this.ln[this.cur.l].trim()) return null;
		let s = this.cur.l, e = this.cur.l;
		while (s > 0 && this.ln[s - 1].trim()) s--;
		while (e < this.ln.length - 1 && this.ln[e + 1].trim()) e++;
		return { s, e };
	}

	private insert(ch: string) {
		this.batch++;
		if (this.batch % 20 === 0 || ch === " " || ch === ".") this.snap();
		const l = this.ln[this.cur.l];
		this.ln[this.cur.l] = l.slice(0, this.cur.c) + ch + l.slice(this.cur.c);
		this.cur.c += ch.length; this.dirty = true;
	}

	private enter() { this.mod(() => {
		const l = this.ln[this.cur.l];
		this.ln[this.cur.l] = l.slice(0, this.cur.c);
		this.ln.splice(this.cur.l + 1, 0, l.slice(this.cur.c));
		this.cur.l++; this.cur.c = 0;
	}); }

	private bs() {
		if (this.cur.c > 0) this.mod(() => {
			const l = this.ln[this.cur.l];
			this.ln[this.cur.l] = l.slice(0, this.cur.c - 1) + l.slice(this.cur.c); this.cur.c--;
		});
		else if (this.cur.l > 0) this.mod(() => {
			const prev = this.ln[this.cur.l - 1];
			this.ln[this.cur.l - 1] = prev + this.ln[this.cur.l];
			this.ln.splice(this.cur.l, 1); this.cur.l--; this.cur.c = prev.length;
		});
	}

	private del() {
		const l = this.ln[this.cur.l];
		if (this.cur.c < l.length) this.mod(() => {
			this.ln[this.cur.l] = l.slice(0, this.cur.c) + l.slice(this.cur.c + 1);
		});
		else if (this.cur.l < this.ln.length - 1) this.mod(() => {
			this.ln[this.cur.l] += this.ln[this.cur.l + 1]; this.ln.splice(this.cur.l + 1, 1);
		});
	}

	private delWord(dir: -1 | 1) {
		const l = this.ln[this.cur.l];
		if (dir < 0) {
			if (this.cur.c === 0) { this.bs(); return; }
			this.mod(() => {
				let c = this.cur.c;
				while (c > 0 && l[c - 1] === " ") c--;
				while (c > 0 && l[c - 1] !== " ") c--;
				this.ln[this.cur.l] = l.slice(0, c) + l.slice(this.cur.c); this.cur.c = c;
			});
		} else {
			if (this.cur.c >= l.length) { this.del(); return; }
			this.mod(() => {
				let c = this.cur.c;
				while (c < l.length && l[c] !== " ") c++;
				while (c < l.length && l[c] === " ") c++;
				this.ln[this.cur.l] = l.slice(0, this.cur.c) + l.slice(c);
			});
		}
	}

	private kill(dir: -1 | 1) { this.mod(() => {
		const l = this.ln[this.cur.l];
		if (dir > 0) {
			if (this.cur.c >= l.length && this.cur.l < this.ln.length - 1) {
				this.ln[this.cur.l] = l + this.ln[this.cur.l + 1]; this.ln.splice(this.cur.l + 1, 1);
			} else this.ln[this.cur.l] = l.slice(0, this.cur.c);
		} else { this.ln[this.cur.l] = l.slice(this.cur.c); this.cur.c = 0; }
	}); }

	private moveH(d: -1 | 1) {
		if (d < 0) {
			if (this.cur.c > 0) this.cur.c--;
			else if (this.cur.l > 0) { this.cur.l--; this.cur.c = this.ln[this.cur.l].length; }
		} else {
			if (this.cur.c < this.ln[this.cur.l].length) this.cur.c++;
			else if (this.cur.l < this.ln.length - 1) { this.cur.l++; this.cur.c = 0; }
		}
	}

	private moveV(d: -1 | 1, vls: any[]) {
		const { vi, vc } = this.vcursor(vls);
		const ti = vi + d;
		if (ti >= 0 && ti < vls.length) {
			const t = vls[ti];
			this.cur.l = t.ll; this.cur.c = t.sc + Math.min(vc, t.t.length);
		}
	}

	private wordJump(dir: -1 | 1) {
		const l = this.ln[this.cur.l];
		if (dir < 0) {
			if (this.cur.c === 0 && this.cur.l > 0) { this.cur.l--; this.cur.c = this.ln[this.cur.l].length; return; }
			let c = this.cur.c;
			while (c > 0 && l[c - 1] === " ") c--;
			while (c > 0 && l[c - 1] !== " ") c--;
			this.cur.c = c;
		} else {
			if (this.cur.c >= l.length && this.cur.l < this.ln.length - 1) { this.cur.l++; this.cur.c = 0; return; }
			let c = this.cur.c;
			while (c < l.length && l[c] !== " ") c++;
			while (c < l.length && l[c] === " ") c++;
			this.cur.c = c;
		}
	}

	private save() {
		if (!existsSync(JOURNAL)) mkdirSync(JOURNAL, { recursive: true });
		writeFileSync(this.path, this.ln.join("\n"), "utf-8");
		this.dirty = false; this.saved = this.ver + 1;
	}

	private close() { clearInterval(this.tick); this.save(); this.done(); }

	private elapsed() {
		const s = Math.floor((Date.now() - this.t0) / 1000);
		const m = Math.floor(s / 60);
		return `${m}:${String(s % 60).padStart(2, "0")}`;
	}

	private words() { return this.ln.join(" ").split(/\s+/).filter(w => w.length > 0).length; }

	handleInput(data: string) {
		if (this.help) { this.help = false; this.ver++; this.tui.requestRender(); return; }
		const cw = Math.min(W, (this.tui.terminal?.cols || 80) - 8);
		const vls = this.vlines(cw);
		const k = (key: any) => matchesKey(data, key);

		if (k(Key.ctrl("/")))      { this.help = true; }
		else if (k(Key.escape))    { this.close(); return; }
		else if (k(Key.ctrl("s"))) { this.save(); }
		else if (k(Key.ctrl("g"))) { this.focus = !this.focus; }
		else if (k(Key.ctrl("z")) || k(Key.ctrl("-"))) { this.undo(); }
		else if (k(Key.up))        { this.moveV(-1, vls); }
		else if (k(Key.down))      { this.moveV(1, vls); }
		else if (k(Key.left) || k(Key.ctrl("b")))  { this.moveH(-1); }
		else if (k(Key.right) || k(Key.ctrl("f"))) { this.moveH(1); }
		else if (k(Key.alt("b")) || k(Key.alt("left")))  { this.wordJump(-1); }
		else if (k(Key.alt("f")) || k(Key.alt("right"))) { this.wordJump(1); }
		else if (k(Key.home) || k(Key.ctrl("a"))) { this.cur.c = 0; }
		else if (k(Key.end) || k(Key.ctrl("e")))  { this.cur.c = this.ln[this.cur.l].length; }
		else if (k(Key.backspace) || k(Key.ctrl("h"))) { this.bs(); }
		else if (k(Key.delete) || k(Key.ctrl("d"))) { this.del(); }
		else if (k(Key.ctrl("w")) || k(Key.alt("backspace"))) { this.delWord(-1); }
		else if (k(Key.alt("d")))  { this.delWord(1); }
		else if (k(Key.ctrl("k"))) { this.kill(1); }
		else if (k(Key.ctrl("u"))) { this.kill(-1); }
		else if (k(Key.enter))     { this.enter(); }
		else if (k(Key.tab))       { this.insert("    "); }
		else if (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32) { this.insert(data); }
		else return;
		this.ver++; this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cv === this.ver && this.cw === width) return this.cl;
		const rows = this.tui.terminal?.rows || 24;
		const cw = Math.min(W, width - 8);
		const margin = " ".repeat(Math.max(0, (width - cw) >> 1));
		const h = rows - 1;

		if (this.help) {
			const lines = [
				"", BOLD + "writer" + R, "",
				DIM + "── movement ──" + R,
				"←  Ctrl+B        back one char",  "→  Ctrl+F        forward one char",
				"↑  ↓             up / down",
				"Alt+B  Alt+←     word left",       "Alt+F  Alt+→     word right",
				"Ctrl+A  Home     line start",      "Ctrl+E  End      line end", "",
				DIM + "── deletion ──" + R,
				"Backspace        delete char back", "Delete  Ctrl+D   delete char forward",
				"Ctrl+W           delete word back", "Alt+D            delete word forward",
				"Ctrl+K           kill to line end", "Ctrl+U           kill to line start", "",
				DIM + "── writer ──" + R,
				"Esc              save and close",   "Ctrl+S           save",
				"Ctrl+G           toggle focus",     "Ctrl+Z  Ctrl+-   undo",
				"Ctrl+/           this help", "",
				DIM + "press any key to return" + R,
			];
			const gap = Math.max(0, (h - lines.length) >> 1);
			const out = Array.from({ length: h }, (_, i) => {
				const li = i - gap;
				return li >= 0 && li < lines.length ? margin + "  " + lines[li] : "";
			});
			out.push(DIM + "  Ctrl+/ help" + " ".repeat(Math.max(1, width - 15)) + R);
			return (this.cl = out, this.cv = this.ver, this.cw = width, out);
		}

		const vls = this.vlines(cw);
		const { vi: ci, vc: cc } = this.vcursor(vls);
		const p = this.focus ? this.para() : null;
		this.scroll = Math.max(0, PAD + ci - Math.floor(h * 0.4));

		const out: string[] = [];
		for (let r = 0; r < h; r++) {
			const vi = this.scroll + r - PAD;
			if (vi < 0 || vi >= vls.length) { out.push(""); continue; }
			const vl = vls[vi];
			const dim = this.focus && !(p && vl.ll >= p.s && vl.ll <= p.e);
			const hd = this.ln[vl.ll][0] === "#";
			const pre = dim ? DIM : hd ? BOLD : "";
			if (vi === ci) {
				const ch = cc < vl.t.length ? vl.t[cc] : " ";
				out.push(margin + pre + vl.t.slice(0, cc) + R + REV + ch + R + pre + (cc < vl.t.length ? vl.t.slice(cc + 1) : "") + R);
			} else out.push(margin + (pre ? pre + vl.t + R : vl.t));
		}

		const left = `  ${this.words()} words · ${this.elapsed()}`;
		const mid = "Ctrl+/ help";
		const right = (this.saved === this.ver ? "saved · " : this.dirty ? "· " : "") + this.name + "  ";
		const g = Math.max(1, ((width - left.length - mid.length - right.length) >> 1));
		const g2 = Math.max(1, width - left.length - mid.length - right.length - g);
		out.push(DIM + left + " ".repeat(g) + mid + " ".repeat(g2) + right + R);

		return (this.cl = out, this.cv = this.ver, this.cw = width, out);
	}

	invalidate() { this.cv = -1; }
}

function resolveFile(arg?: string) {
	if (!existsSync(JOURNAL)) mkdirSync(JOURNAL, { recursive: true });
	if (!arg) {
		const d = new Date(), date = d.toISOString().slice(0, 10);
		const name = `${date}-${d.toTimeString().slice(0, 5).replace(":", "")}.md`;
		return { path: join(JOURNAL, name), name, content: `# ${date}\n\n` };
	}
	const name = arg.endsWith(".md") ? arg : `${arg}.md`;
	const path = join(JOURNAL, name);
	if (existsSync(path)) return { path, name, content: readFileSync(path, "utf-8") };
	return { path, name, content: `# ${arg}\n\n` };
}

function listFiles() {
	if (!existsSync(JOURNAL)) return [];
	return readdirSync(JOURNAL).filter(f => f.endsWith(".md")).map(f => {
		const p = join(JOURNAL, f), content = readFileSync(p, "utf-8");
		return {
			name: f, path: p, modified: statSync(p).mtimeMs,
			words: content.split(/\s+/).filter(w => w.length > 0).length,
			preview: (content.split("\n")[0] || "").replace(/^#+\s*/, "").slice(0, 50),
		};
	}).sort((a, b) => b.modified - a.modified);
}

function age(ms: number) {
	const m = Math.floor((Date.now() - ms) / 60000);
	if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24); return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("write", {
		description: "Minimalist writing mode",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("write requires interactive mode", "error"); return; }
			const arg = args?.trim() || "";

			if (arg.length > 0) {
				const f = resolveFile(arg === "new" ? undefined : arg);
				return open(ctx, f);
			}

			const files = listFiles();
			const items: SelectItem[] = [
				{ value: "__new__", label: "✦ New entry", description: "fresh journal file" },
				...files.map(f => ({
					value: f.name,
					label: f.name.replace(".md", ""),
					description: `${f.words} words · ${age(f.modified)}${f.preview ? " · " + f.preview : ""}`,
				})),
			];

			const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const c = new Container();
				c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				c.addChild(new Text(theme.fg("accent", theme.bold(" journal")), 1, 0));
				const sl = new SelectList(items, Math.min(items.length, 15), {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});
				sl.onSelect = item => done(item.value);
				sl.onCancel = () => done(null);
				c.addChild(sl);
				c.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter open · esc cancel"), 1, 0));
				c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return {
					render: (w: number) => c.render(w),
					invalidate: () => c.invalidate(),
					handleInput: (d: string) => { sl.handleInput(d); tui.requestRender(); },
				};
			});

			if (picked) await open(ctx, resolveFile(picked === "__new__" ? undefined : picked));
		},
	});

	async function open(ctx: any, f: { path: string; name: string; content: string }) {
		await ctx.ui.custom((tui: any, _t: any, _k: any, done: any) =>
			new Writer(tui, f.path, f.name, f.content, () => done(undefined)));
		ctx.ui.notify(`${f.name} saved`, "info");
	}
}
