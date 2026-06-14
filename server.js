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
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
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

  const { sessionId, messages } = req.body;

  // Log the latest user message
  if (sessionId && messages?.length) {
    const last = messages[messages.length - 1];
    if (last.role === 'user') await logMessage(sessionId, 'user', last.content);
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
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

  const sessionsRes = await pool.query(
    `SELECT session_id,
            MIN(created_at) AS started,
            MAX(created_at) AS last_msg,
            COUNT(*) AS msg_count,
            (SELECT content FROM conversations c2
             WHERE c2.session_id = c.session_id AND c2.role = 'user'
             ORDER BY created_at LIMIT 1) AS first_message
     FROM conversations c
     WHERE ($1 = '' OR content ILIKE $2)
     GROUP BY session_id
     ORDER BY last_msg DESC
     LIMIT $3 OFFSET $4`,
    [search, `%${search}%`, limit, offset]
  );

  const rows = sessionsRes.rows.map(r => `
    <tr onclick="location.href='/admin/session/${r.session_id}'" style="cursor:pointer">
      <td>${new Date(r.started).toLocaleString()}</td>
      <td>${new Date(r.last_msg).toLocaleString()}</td>
      <td>${r.msg_count}</td>
      <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.first_message || '')}</td>
    </tr>`).join('');

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).map(p =>
    `<a href="?page=${p}${search ? '&q=' + encodeURIComponent(search) : ''}"
        style="margin:0 3px;${p === page ? 'font-weight:bold;text-decoration:none;color:#e3b23c' : ''}">${p}</a>`
  ).join('');

  res.send(`<!DOCTYPE html><html><head><title>Admin — Nathaniel The Great</title>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:sans-serif;background:#0c0c0e;color:#f1ede4;padding:24px;margin:0}
    h1{color:#e3b23c;font-size:22px;margin-bottom:20px}
    form{margin-bottom:20px;display:flex;gap:8px}
    input{background:#17151a;border:1px solid #252230;color:#f1ede4;padding:8px 12px;border-radius:8px;font-size:14px;flex:1}
    button{background:#e3b23c;color:#0c0c0e;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:bold}
    table{width:100%;border-collapse:collapse;font-size:14px}
    th{text-align:left;color:#8d8893;border-bottom:1px solid #252230;padding:8px 12px;font-weight:500}
    td{padding:10px 12px;border-bottom:1px solid #1a1820;vertical-align:top}
    tr:hover td{background:#17151a}
    .pages{margin-top:20px;color:#8d8893}
    .pages a{color:#8d8893}
    .stat{color:#8d8893;font-size:13px;margin-bottom:16px}
  </style></head><body>
  <h1>Nathaniel The Great — Conversations</h1>
  <p class="stat">${total} total sessions</p>
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
  </body></html>`);
});

app.get('/admin/session/:sessionId', adminAuth, async (req, res) => {
  if (!pool) return res.status(503).send('No database connected.');

  const { sessionId } = req.params;
  const result = await pool.query(
    'SELECT role, content, created_at FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );

  const messages = result.rows.map(r => {
    const isUser = r.role === 'user';
    return `<div style="margin-bottom:16px;display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'}">
      <div style="font-size:10px;color:#8d8893;margin-bottom:4px;${isUser ? 'text-align:right' : ''}">${isUser ? 'ARTIST' : 'NATHANIEL THE GREAT'} · ${new Date(r.created_at).toLocaleString()}</div>
      <div style="max-width:75%;padding:12px 16px;border-radius:${isUser ? '16px 4px 4px 16px' : '4px 16px 16px 4px'};background:${isUser ? 'rgba(192,38,58,0.15)' : '#17151a'};border-left:${isUser ? 'none' : '3px solid #e3b23c'};font-size:14px;line-height:1.6;white-space:pre-wrap">${escHtml(r.content)}</div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html><html><head><title>Session — Admin</title>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:sans-serif;background:#0c0c0e;color:#f1ede4;padding:24px;margin:0;max-width:800px}
  a{color:#e3b23c}h2{color:#e3b23c;margin-bottom:20px;font-size:18px}</style></head><body>
  <a href="/admin">← Back</a>
  <h2>Session: ${escHtml(sessionId)}</h2>
  ${messages || '<p style="color:#8d8893">No messages.</p>'}
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
