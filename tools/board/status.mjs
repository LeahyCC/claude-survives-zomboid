// Board status for the zomboid-pro cards, plus the tail of one card's transcript.
//   node status.mjs            all cards
//   node status.mjs <id8> [n]  last n transcript entries of that card
const base = 'http://localhost:4747';
const [id, n] = process.argv.slice(2);
const tasks = await (await fetch(`${base}/api/tasks`)).json();
const list = (tasks.tasks || tasks).filter((t) => t.group === 'zomboid-pro');
if (!id) {
  for (const t of list) {
    const age = t.startedAt ? Math.round((Date.now() - new Date(t.startedAt).getTime()) / 60000) + 'm' : '';
    console.log(`${t.id.slice(0, 8)} ${t.status.padEnd(8)} ${age.padStart(4)} ${t.permissionBlocked ? 'PERM ' : ''}${t.error ? 'ERR ' : ''}${t.title.slice(0, 70)}`);
    if (t.error) console.log(`         error: ${String(t.error).slice(0, 200)}`);
  }
} else {
  const t = list.find((x) => x.id.startsWith(id));
  const tr = await (await fetch(`${base}/api/tasks/${t.id}/transcript`)).json();
  const entries = Array.isArray(tr) ? tr : (tr.transcript || []);
  for (const e of entries.slice(-(Number(n) || 15))) {
    const text = typeof e.text === 'string' ? e.text : JSON.stringify(e).slice(0, 300);
    console.log(`[${e.kind || e.type}] ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (t.resultText) console.log('RESULT:', t.resultText.slice(0, 4000));
}
