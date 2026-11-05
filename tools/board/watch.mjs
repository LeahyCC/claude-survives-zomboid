// Exit when a zomboid-pro card needs the manager: review, failed, error, permission block,
// or running with no transcript growth for 15 minutes (stuck).
const base = 'http://localhost:4747';
const seen = new Map();
const deadline = Date.now() + 55 * 60000;
while (Date.now() < deadline) {
  try {
    const j = await (await fetch(`${base}/api/tasks`)).json();
    const list = (j.tasks || j).filter((t) => t.group === 'zomboid-pro');
    for (const t of list) {
      if (t.status === 'running') {
        if (t.permissionBlocked) { console.log('PERM', t.id.slice(0, 8), t.title); process.exit(0); }
        const size = JSON.stringify(t.liveOut || '').length + (t.ctxTokens || 0);
        const prev = seen.get(t.id);
        if (!prev || prev.size !== size) seen.set(t.id, { size, at: Date.now() });
        else if (Date.now() - prev.at > 15 * 60000) { console.log('STALL', t.id.slice(0, 8), t.title); process.exit(0); }
      }
      if (['review', 'failed', 'error'].includes(t.status) || t.error) {
        if (t.status !== 'done') { console.log(t.status.toUpperCase(), t.id.slice(0, 8), t.title, t.error || ''); process.exit(0); }
      }
    }
  } catch (e) { console.log('board unreachable', e.message); }
  await new Promise((r) => setTimeout(r, 30000));
}
console.log('TIMEOUT no change in 55 minutes');
