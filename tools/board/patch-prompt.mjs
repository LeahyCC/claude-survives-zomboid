// Append a note to a queued card's prompt.  node patch-prompt.mjs <id8> <file-with-note>
import fs from 'node:fs';
const [id8, file] = process.argv.slice(2);
const base = 'http://localhost:4747';
const tasks = await (await fetch(`${base}/api/tasks`)).json();
const t = (tasks.tasks || tasks).find((x) => x.id.startsWith(id8));
if (!t) throw new Error('no card ' + id8);
const note = fs.readFileSync(file, 'utf8').trim();
if (t.prompt.includes(note.slice(0, 60))) { console.log('already there'); process.exit(0); }
const prompt = t.prompt.replace('**When you finish**', note + '\n\n**When you finish**');
const res = await fetch(`${base}/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
console.log(res.status, (await res.json()).prompt.length);
