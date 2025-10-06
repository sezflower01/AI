const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const PQueue = require('p-queue').default;

const PORT = process.env.PORT || 8080;
const ENGINES = Number(process.env.ENGINES || 2);
const HASH = Number(process.env.HASH || 128);
const THREADS = Number(process.env.THREADS || 1);
const MOVE_TIMEOUT_MS = Number(process.env.MOVE_TIMEOUT_MS || 15000);

class UciEngine {
  constructor() {
    this.proc = spawn('stockfish', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.listeners = [];
    this.ready = false;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      chunk.split(/\r?\n/).forEach(line => line && this.listeners.forEach(l => l(line)));
    });
    this.proc.stderr.on('data', d => console.error('[SF][stderr]', String(d)));
    this.proc.on('exit', (c, s) => console.error('[SF] exited', c, s));
  }
  write(cmd) { this.proc.stdin.write(cmd + '\n'); }
  on(fn) { this.listeners.push(fn); }
  off(fn) { this.listeners = this.listeners.filter(f => f !== fn); }
  waitFor(needle, ms = MOVE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; this.off(h); reject(new Error(`Timeout waiting for "${needle}"`)); } }, ms);
      const h = line => {
        if (line.toLowerCase().includes(needle.toLowerCase())) {
          if (!done) { done = true; clearTimeout(t); this.off(h); resolve(); }
        }
      };
      this.on(h);
    });
  }
  async init() {
    if (this.ready) return;
    this.write('uci');      await this.waitFor('uciok', 5000);
    this.write(`setoption name Hash value ${HASH}`);
    this.write(`setoption name Threads value ${THREADS}`);
    this.write('isready');  await this.waitFor('readyok', 5000);
    this.ready = true;
  }
  async bestmoveFromFEN(fen, { depth = 15, movetime } = {}) {
    await this.init();
    this.write('stop'); this.write('ucinewgame'); this.write('isready');
    await this.waitFor('readyok', 5000);
    this.write(`position fen ${fen}`);
    if (movetime) this.write(`go movetime ${movetime}`); else this.write(`go depth ${depth}`);
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; reject(new Error('Timeout waiting for bestmove')); } }, MOVE_TIMEOUT_MS);
      const h = line => {
        if (line.startsWith('bestmove')) {
          const bestmove = line.split(/\s+/)[1];
          if (!done) { done = true; clearTimeout(t); this.off(h); resolve({ bestmove }); }
        }
      };
      this.on(h);
    });
  }
}

const pool  = Array.from({ length: ENGINES }, () => new UciEngine());
const queue = new PQueue({ concurrency: ENGINES });

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/bestmove', async (req, res) => {
  try {
    const { fen, depth, movetime } = req.body || {};
    if (!fen) return res.status(400).json({ error: 'fen required' });
    const job = () => pool[Math.floor(Math.random()*pool.length)].bestmoveFromFEN(fen, { depth, movetime });
    const { bestmove } = await queue.add(job, { timeout: MOVE_TIMEOUT_MS + 2000 });
    res.json({ bestmove });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

app.listen(PORT, () => console.log('Stockfish API listening on :' + PORT));
