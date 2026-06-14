const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ─────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      artist TEXT,
      instagram TEXT,
      email TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
    CREATE TABLE IF NOT EXISTS session_takeovers (
      session_id TEXT PRIMARY KEY,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      delivered BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS flagged_sessions (
      session_id TEXT PRIMARY KEY,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

async function logMessage(sessionId, role, content) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO conversations (session_id, role, content) VALUES ($1, $2, $3)',
      [sessionId, role, content]
    );
  } catch (err) {
    console.error('DB log error:', err.message);
  }
}

const PAYMENT_KEYWORDS = ['pay you','pay me','pay the team','how much','pricing','rates','hire you','hire the team','work with you','work with your team','cost','invoice','budget','retainer','fee','fees','how do i pay','i want to pay','ready to pay','sign up','purchase','buy'];

async function checkAndFlagPayment(sessionId, content) {
  if (!pool) return;
  const lower = content.toLowerCase();
  if (PAYMENT_KEYWORDS.some(k => lower.includes(k))) {
    await pool.query(
      `INSERT INTO flagged_sessions (session_id, reason) VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, 'Payment intent detected']
    );
  }
}

// ── HISTORY — client fetches past messages ────────────────
app.get('/api/history/:sessionId', async (req, res) => {
  if (!pool) return res.json({ messages: [] });
  const result = await pool.query(
    'SELECT role, content FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
    [req.params.sessionId]
  );
  res.json({ messages: result.rows });
});

// ── POLL — client checks for admin messages ───────────────
app.get('/api/poll/:sessionId', async (req, res) => {
  if (!pool) return res.json({ takeover: false, message: null });
  const { sessionId } = req.params;
  const [takeoverRes, msgRes] = await Promise.all([
    pool.query('SELECT active FROM session_takeovers WHERE session_id = $1', [sessionId]),
    pool.query('SELECT id, content FROM admin_messages WHERE session_id = $1 AND delivered = FALSE ORDER BY created_at ASC LIMIT 1', [sessionId]),
  ]);
  const takeover = takeoverRes.rows[0]?.active || false;
  const msg = msgRes.rows[0] || null;
  if (msg) {
    await pool.query('UPDATE admin_messages SET delivered = TRUE WHERE id = $1', [msg.id]);
  }
  res.json({ takeover, message: msg ? msg.content : null });
});

// ── ADMIN TAKEOVER CONTROLS ───────────────────────────────
app.post('/admin/api/takeover/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.json({ ok: false });
  const { sessionId } = req.params;
  const { active } = req.body;
  await pool.query(
    `INSERT INTO session_takeovers (session_id, active) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET active = $2`,
    [decodeURIComponent(sessionId), active]
  );
  res.json({ ok: true });
});

app.post('/admin/api/send/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.json({ ok: false });
  const { sessionId } = req.params;
  const { content } = req.body;
  const sid = decodeURIComponent(sessionId);
  await pool.query('INSERT INTO admin_messages (session_id, content) VALUES ($1, $2)', [sid, content]);
  await logMessage(sid, 'assistant', content);
  res.json({ ok: true });
});

// ── LEAD CAPTURE ─────────────────────────────────────────
app.post('/api/lead', async (req, res) => {
  const { sessionId, artist, instagram, email, phone } = req.body;
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO leads (session_id, artist, instagram, email, phone) VALUES ($1, $2, $3, $4, $5)',
        [sessionId, artist, instagram, email, phone]
      );
    } catch (err) {
      console.error('Lead save error:', err.message);
    }
  }
  res.json({ ok: true });
});

// ── TRANSCRIPTION ─────────────────────────────────────────
app.post('/api/transcribe', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DEEPGRAM_API_KEY is not set on the server.' });

  try {
    const contentType = req.headers['content-type'] || 'audio/webm';
    const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
      method: 'POST',
      headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': contentType },
      body: req.body,
    });
    const data = await response.json();
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Deepgram API.' });
  }
});

// ── CHAT ──────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server.' } });

  const { sessionId, messages, ...anthropicBody } = req.body;

  // Log user message and check for payment intent
  if (sessionId && messages?.length) {
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      await logMessage(sessionId, 'user', last.content);
      await checkAndFlagPayment(sessionId, last.content);
    }
  }

  // If admin has taken over this session, hold — client will get message via poll
  if (pool && sessionId) {
    const t = await pool.query('SELECT active FROM session_takeovers WHERE session_id = $1', [sessionId]);
    if (t.rows[0]?.active) {
      return res.json({ takeover: true });
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...anthropicBody, messages }),
    });

    const data = await response.json();

    // Log the assistant reply
    if (sessionId && data?.content?.[0]?.text) {
      await logMessage(sessionId, 'assistant', data.content[0].text);
    }

    res.status(response.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: 'Failed to reach Anthropic API.' } });
  }
});

// ── ADMIN DASHBOARD ───────────────────────────────────────
function adminAuth(req, res, next) {
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return res.status(503).send('Admin not configured — set ADMIN_PASSWORD env var.');
  const auth = req.headers.authorization || '';
  const [, encoded] = auth.split(' ');
  if (!encoded) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }
  const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (pass !== adminPass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Wrong password');
  }
  next();
}

app.get('/admin', adminAuth, async (req, res) => {
  if (!pool) return res.status(503).send('No database connected.');

  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const search = req.query.q || '';

  const countRes = await pool.query(
    `SELECT COUNT(DISTINCT session_id) FROM conversations
     WHERE ($1 = '' OR content ILIKE $2)`,
    [search, `%${search}%`]
  );
  const total = parseInt(countRes.rows[0].count);
  const totalPages = Math.ceil(total / limit);

  const [sessionsRes, flaggedRes, takeoverRes] = await Promise.all([
    pool.query(
      `SELECT c.session_id,
              MIN(c.created_at) AS started,
              MAX(c.created_at) AS last_msg,
              COUNT(*) AS msg_count,
              (SELECT content FROM conversations c2
               WHERE c2.session_id = c.session_id AND c2.role = 'user'
               ORDER BY created_at LIMIT 1) AS first_message,
              f.session_id IS NOT NULL AS flagged,
              t.active AS takeover_active
       FROM conversations c
       LEFT JOIN flagged_sessions f ON f.session_id = c.session_id
       LEFT JOIN session_takeovers t ON t.session_id = c.session_id
       WHERE ($1 = '' OR c.content ILIKE $2)
       GROUP BY c.session_id, f.session_id, t.active
       ORDER BY last_msg DESC
       LIMIT $3 OFFSET $4`,
      [search, `%${search}%`, limit, offset]
    ),
    pool.query('SELECT session_id FROM flagged_sessions'),
    pool.query('SELECT session_id FROM session_takeovers WHERE active = TRUE'),
  ]);

  const leadsRes = await pool.query(
    `SELECT session_id, artist, instagram, email, phone, created_at FROM leads ORDER BY created_at DESC LIMIT 100`
  );
  const leadRows = leadsRes.rows.map(r => `
    <tr>
      <td><a href="#conversation-panel" onclick="loadConvo('${encodeURIComponent(r.session_id)}','${escHtml(r.artist||'Unknown')}')" style="color:#e3b23c;text-decoration:none;font-weight:bold;cursor:pointer">${escHtml(r.artist || 'Unknown')}</a></td>
      <td>${escHtml(r.instagram || '')}</td>
      <td>${escHtml(r.email || '')}</td>
      <td>${escHtml(r.phone || '')}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
    </tr>`).join('');

  const rows = sessionsRes.rows.map(r => `
    <tr onclick="loadConvo('${encodeURIComponent(r.session_id)}','Session')" style="cursor:pointer">
      <td>${new Date(r.started).toLocaleString()}</td>
      <td>${new Date(r.last_msg).toLocaleString()}</td>
      <td>${r.msg_count}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.first_message || '')}</td>
      <td>${r.flagged ? '<span style="background:#c0263a;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:bold">💰 WANTS TO PAY</span>' : ''} ${r.takeover_active ? '<span style="background:#e3b23c;color:#000;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:bold">🎙 LIVE</span>' : ''}</td>
    </tr>`).join('');

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).map(p =>
    `<a href="?page=${p}${search ? '&q=' + encodeURIComponent(search) : ''}"
        style="margin:0 3px;${p === page ? 'font-weight:bold;text-decoration:none;color:#e3b23c' : ''}">${p}</a>`
  ).join('');

  res.send(`<!DOCTYPE html><html><head><title>Admin — Nathaniel The Great</title>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:sans-serif;background:#0c0c0e;color:#f1ede4;padding:24px;margin:0}
    h1,h2{color:#e3b23c} h1{font-size:22px;margin-bottom:8px} h2{font-size:15px;margin:28px 0 10px;letter-spacing:0.08em;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:32px}
    th{text-align:left;color:#8d8893;border-bottom:1px solid #252230;padding:8px 12px;font-weight:500}
    td{padding:10px 12px;border-bottom:1px solid #1a1820;vertical-align:top}
    tr:hover td{background:#17151a} a{color:#8d8893}
    form{margin-bottom:20px;display:flex;gap:8px}
    input{background:#17151a;border:1px solid #252230;color:#f1ede4;padding:8px 12px;border-radius:8px;font-size:14px;flex:1}
    button{background:#e3b23c;color:#0c0c0e;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:bold}
    .stat{color:#8d8893;font-size:13px;margin-bottom:16px}
    .pages{margin-top:20px;color:#8d8893} .pages a{color:#8d8893}
  </style></head><body>
  <h1>Nathaniel The Great — Dashboard</h1>
  <p class="stat">${total} total conversations</p>

  <h2>Leads</h2>
  <table>
    <thead><tr><th>Artist</th><th>Instagram</th><th>Email</th><th>Phone</th><th>Date</th></tr></thead>
    <tbody>${leadRows || '<tr><td colspan="5" style="color:#8d8893;padding:20px">No leads yet.</td></tr>'}</tbody>
  </table>

  <h2>Conversations</h2>
  <form method="get">
    <input name="q" value="${escHtml(search)}" placeholder="Search conversations…">
    <button type="submit">Search</button>
    ${search ? '<a href="/admin"><button type="button">Clear</button></a>' : ''}
  </form>
  <table>
    <thead><tr><th>Started</th><th>Last Message</th><th>Messages</th><th>First Message</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="color:#8d8893;padding:20px">No conversations yet.</td></tr>'}</tbody>
  </table>
  <div class="pages">${pages}</div>

  <div id="conversation-panel" style="display:none;margin-top:40px;border-top:1px solid #252230;padding-top:28px">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;flex-wrap:wrap">
      <h2 id="convo-title" style="color:#e3b23c;font-size:18px;margin:0"></h2>
      <span id="live-badge" style="display:none;background:#e3b23c;color:#000;font-size:11px;padding:3px 10px;border-radius:10px;font-weight:bold">🎙 YOU'RE LIVE</span>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
      <button id="takeover-btn" onclick="toggleTakeover()" style="background:#e3b23c;color:#000;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-weight:bold;font-size:13px">Take Over Chat</button>
      <button onclick="refreshConvo()" style="background:#17151a;color:#f1ede4;border:1px solid #252230;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:13px">Refresh</button>
    </div>
    <div id="takeover-input" style="display:none;margin-bottom:20px;display:none">
      <div style="display:flex;gap:10px">
        <input id="admin-msg" placeholder="Type your reply as Nathaniel…" style="flex:1;background:#0c0c0e;border:1px solid #e3b23c;color:#fff;padding:11px 14px;border-radius:10px;font-size:14px;outline:none">
        <button onclick="sendAdminMsg()" style="background:#e3b23c;color:#000;border:none;padding:11px 20px;border-radius:10px;cursor:pointer;font-weight:bold">Send</button>
      </div>
    </div>
    <div id="convo-messages"></div>
  </div>

  <script>
  let currentSession = null;
  let currentName = null;
  let isTakeover = false;
  let refreshTimer = null;

  async function loadConvo(sessionId, name) {
    currentSession = sessionId;
    currentName = name;
    const panel = document.getElementById('conversation-panel');
    const title = document.getElementById('convo-title');
    title.textContent = name;
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth' });
    if (refreshTimer) clearInterval(refreshTimer);
    await refreshConvo();
    refreshTimer = setInterval(refreshConvo, 5000);
  }

  async function refreshConvo() {
    if (!currentSession) return;
    const msgs = document.getElementById('convo-messages');
    const res  = await fetch('/admin/api/session/' + currentSession);
    const data = await res.json();

    // Check takeover state
    const tRes = await fetch('/admin/api/takeover-status/' + currentSession);
    const tData = await tRes.json();
    isTakeover = tData.active;
    updateTakeoverUI();

    if (!data.messages || data.messages.length === 0) {
      msgs.innerHTML = '<p style="color:#8d8893">No messages yet.</p>';
      return;
    }
    msgs.innerHTML = data.messages.map(m => {
      const isUser = m.role === 'user';
      const time   = new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      return \`<div style="margin-bottom:18px;display:flex;flex-direction:column;align-items:\${isUser?'flex-end':'flex-start'}">
        <div style="font-size:11px;color:#8d8893;margin-bottom:4px">\${isUser ? currentName : 'Nathaniel The Great'} · \${time}</div>
        <div style="max-width:75%;padding:12px 16px;border-radius:\${isUser?'16px 4px 4px 16px':'4px 16px 16px 4px'};background:\${isUser?'rgba(192,38,58,0.15)':'#17151a'};\${isUser?'border:1px solid rgba(192,38,58,0.3)':'border-left:3px solid #e3b23c'};font-size:14px;line-height:1.6;white-space:pre-wrap">\${m.content}</div>
      </div>\`;
    }).join('');
  }

  function updateTakeoverUI() {
    const btn   = document.getElementById('takeover-btn');
    const badge = document.getElementById('live-badge');
    const input = document.getElementById('takeover-input');
    if (isTakeover) {
      btn.textContent   = 'Hand Back to AI';
      btn.style.background = '#c0263a';
      btn.style.color   = '#fff';
      badge.style.display = 'inline-block';
      input.style.display = 'block';
    } else {
      btn.textContent   = 'Take Over Chat';
      btn.style.background = '#e3b23c';
      btn.style.color   = '#000';
      badge.style.display = 'none';
      input.style.display = 'none';
    }
  }

  async function toggleTakeover() {
    isTakeover = !isTakeover;
    await fetch('/admin/api/takeover/' + currentSession, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ active: isTakeover })
    });
    updateTakeoverUI();
  }

  async function sendAdminMsg() {
    const input = document.getElementById('admin-msg');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    await fetch('/admin/api/send/' + currentSession, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content })
    });
    await refreshConvo();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.activeElement.id === 'admin-msg') sendAdminMsg();
  });
  </script>
  </body></html>`);
});

app.get('/admin/api/takeover-status/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.json({ active: false });
  const r = await pool.query('SELECT active FROM session_takeovers WHERE session_id = $1', [decodeURIComponent(req.params.sessionId)]);
  res.json({ active: r.rows[0]?.active || false });
});

app.get('/admin/api/session/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database.' });
  const { sessionId } = req.params;
  const result = await pool.query(
    'SELECT role, content, created_at FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
    [decodeURIComponent(sessionId)]
  );
  res.json({ messages: result.rows });
});

app.get('/admin/session/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.status(503).send('No database connected.');

  const { sessionId } = req.params;

  const [msgResult, leadResult] = await Promise.all([
    pool.query('SELECT role, content, created_at FROM conversations WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]),
    pool.query('SELECT artist, instagram, email, phone FROM leads WHERE session_id = $1 LIMIT 1', [sessionId]),
  ]);

  const lead = leadResult.rows[0] || {};
  const displayName = lead.artist || 'Unknown Artist';

  const messages = msgResult.rows.map(r => {
    const isUser = r.role === 'user';
    const label = isUser ? escHtml(displayName) : 'Nathaniel The Great';
    const time = new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div style="margin-bottom:20px;display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'}">
      <div style="font-size:11px;color:#8d8893;margin-bottom:5px">${label} · ${time}</div>
      <div style="max-width:75%;padding:12px 16px;border-radius:${isUser ? '16px 4px 4px 16px' : '4px 16px 16px 4px'};background:${isUser ? 'rgba(192,38,58,0.15)' : '#17151a'};${isUser ? 'border:1px solid rgba(192,38,58,0.3)' : 'border-left:3px solid #e3b23c'};font-size:14px;line-height:1.6;white-space:pre-wrap">${escHtml(r.content)}</div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html><html><head><title>${escHtml(displayName)} — Conversation</title>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:sans-serif;background:#0c0c0e;color:#f1ede4;padding:24px;margin:0}
    .wrap{max-width:700px;margin:0 auto}
    a{color:#8d8893;text-decoration:none;font-size:13px}
    a:hover{color:#e3b23c}
    .artist-card{background:#111;border:1px solid #252230;border-radius:12px;padding:18px 20px;margin:16px 0 28px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .artist-card h2{color:#e3b23c;font-size:20px;margin:0 0 4px;grid-column:1/-1}
    .info-item{font-size:13px;color:#8d8893}
    .info-item span{color:#f1ede4}
    .messages{padding-top:8px}
  </style></head><body>
  <div class="wrap">
    <a href="/admin">← Back to Dashboard</a>
    <div class="artist-card">
      <h2>${escHtml(displayName)}</h2>
      ${lead.instagram ? `<div class="info-item">Instagram: <span>${escHtml(lead.instagram)}</span></div>` : ''}
      ${lead.email ? `<div class="info-item">Email: <span>${escHtml(lead.email)}</span></div>` : ''}
      ${lead.phone ? `<div class="info-item">Phone: <span>${escHtml(lead.phone)}</span></div>` : ''}
    </div>
    <div class="messages">
      ${messages || '<p style="color:#8d8893">No messages in this session.</p>'}
    </div>
  </div>
  </body></html>`);
});

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
