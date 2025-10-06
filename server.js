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
      chunk.split(/\r?\n/).forEach(line => {
        if (line) this.listeners.forEach(l => l(line));
      });
    });

    this.proc.stderr.on('data', d => console.error('[SF][stderr]', String(d)));
    this.proc.on('exit', (c, s) => console.error('[SF] exited', c, s));
  }
  write(cmd) { this.proc.stdin.write(cmd + '\n'); }
  on(fn) { this.listeners.push(fn); }
  off(fn) { this.listeners = this.listeners.filter(f => f !== fn); }

  waitFor(substr, ms = MOVE_TIMEOUT_MS) {
    return new Promise((res, rej) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; this.off(h); rej(new Error(`Timeout waiting for "${substr}"`)); }
      }, ms);
      const h = line => {
        if (line.toLowerCase().includes(substr.toLowerCase())) {
          if (!done) { done = true; clearTimeout(t); this.off(h); res(); }
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

  async bestmoveFromFEN(fen, { depth = 12, movetime } = {}) {
    await this.init();
    this.write('stop');
    this.write('ucinewgame');
    this.write('isready');
    await this.waitFor('readyok', 5000);

    this.write(`position fen ${fen}`);
    if (movetime) this.write(`go movetime ${movetime}`);
    else this.write(`go depth ${depth}`);

    return new Promise((res, rej) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; rej(new Error('Timeout waiting for bestmove')); }
      }, MOVE_TIMEOUT_MS);
      const h = line => {
        if (line.startsWith('bestmove')) {
          const mv = line.split(/\s+/)[1];
          if (!done) { done = true; clearTimeout(t); this.off(h); res({ bestmove: mv }); }
        }
      };
      this.on(h);
    });
  }
}

const pool = Array.from({ length: ENGINES }, () => new UciEngine());
const queue = new PQueue({ concurrency: ENGINES });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/bestmove', async (req, res) => {
  try {
    let { fen, depth, movetime } = req.body || {};
    if (!fen) return res.status(400).json({ error: 'fen required' });

    // clamp server-side
    const MAX_DEPTH = Number(process.env.MAX_DEPTH || 20);
    if (typeof depth === 'number') {
      depth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(depth)));
      movetime = undefined;
    } else if (typeof movetime !== 'number') {
      depth = 12;
    }

    const job = async () => {
      const eng = pool[Math.floor(Math.random() * pool.length)];
      return eng.bestmoveFromFEN(fen, { depth, movetime });
    };
    const { bestmove } = await queue.add(job, { timeout: MOVE_TIMEOUT_MS + 2000 });
    res.json({ bestmove });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log('Stockfish API listening on ' + PORT));
