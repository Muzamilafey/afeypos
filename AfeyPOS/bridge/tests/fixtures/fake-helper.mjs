// Stand-in for a vendor helper: speaks the bridge's JSON-lines protocol with fake templates.
import readline from 'node:readline';
process.stdout.write('SDK banner line that is not JSON\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const reply = (o) => process.stdout.write(`${JSON.stringify({ id: m.id, ...o })}\n`);
  if (m.cmd === 'status') return reply({ ok: true, connected: true, model: 'FAKE-9000' });
  if (m.cmd === 'capture') {
    if (process.env.FAKE_NO_FINGER) return; // never answers: the bridge times out
    return reply({ ok: true, format: 'fake-v1', template: Buffer.from('enrolled-finger').toString('base64') });
  }
  if (m.cmd === 'match') return reply({ ok: true, matched: m.stored.some((s) => s.template === m.candidate.template), score: 80 });
  if (m.cmd === 'identify') {
    const hit = m.stored.find((s) => s.template === m.candidate.template);
    return reply({ ok: true, userId: hit?.userId ?? null, score: hit ? 77 : 0 });
  }
  if (m.cmd === 'crash') process.exit(3);
  reply({ ok: false, error: `unknown command ${m.cmd}` });
});
