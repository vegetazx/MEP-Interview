// MEP first-round voice screening agent
// -------------------------------------------------
// Plain-English overview of what this file does:
//  1. You (the recruiter) generate a one-time link for a candidate from /admin.
//  2. The candidate opens that link. It shows ONE question at a time, records
//     their voice answer in the browser, and only reveals the next question
//     after the previous answer has been uploaded. The link stops working
//     the moment it has been used once.
//  3. Each audio answer is sent to Groq's free Whisper API and turned into text.
//  4. Once all 10 answers are in, the full transcript is sent to Google's
//     free Gemini API along with a scoring rubric, and it returns a
//     structured verdict (Advance / Hold / Reject + reasoning).
//  5. Everything is saved to results/sessions.json, and you can view it all
//     at /admin (password-protected) as a simple table.
//
// Nothing here costs money at normal screening volumes. The only "cost" is
// your own free API keys (see .env.example).

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const SESSIONS_FILE = path.join(__dirname, 'results', 'sessions.json');
const AUDIO_DIR = path.join(__dirname, 'results', 'audio');
const TMP_DIR = path.join(__dirname, 'results', 'tmp');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');

// ---- tiny JSON-file "database" (fine at this volume; swap for a real DB later if needed) ----
function loadSessions() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}
function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'results', 'tmp') });

// ============================================================
// ADMIN: create a one-time link for a candidate
// ============================================================
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong admin password' });
  next();
}

app.post('/admin/api/create-link', requireAdmin, (req, res) => {
  const { candidateName, candidatePhone } = req.body;
  if (!candidateName) return res.status(400).json({ error: 'candidateName is required' });

  const token = uuidv4();
  const sessions = loadSessions();
  sessions[token] = {
    token,
    candidateName,
    candidatePhone: candidatePhone || '',
    createdAt: new Date().toISOString(),
    started: false,
    completed: false,
    currentQuestionIndex: 0, // 0-based index into QUESTIONS.questions
    answers: [], // { questionId, questionText, transcript }
    score: null
  };
  saveSessions(sessions);

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ link: `${baseUrl}/screen/${token}`, token });
});

app.get('/admin/api/results', requireAdmin, (req, res) => {
  const sessions = loadSessions();
  res.json(Object.values(sessions));
});

// ============================================================
// CANDIDATE-FACING: the one-time screening link
// ============================================================

// Serves the recording page itself, but only if the link hasn't been used up.
app.get('/screen/:token', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.token];
  if (!session) return res.status(404).send(renderMessagePage('This link is not valid.'));
  if (session.completed) return res.status(410).send(renderMessagePage('This screening link has already been used. If you believe this is an error, please contact us directly.'));
  res.sendFile(path.join(__dirname, 'views', 'screen.html'));
});

// Admin dashboard page (the page itself has no secrets in it — every data
// call it makes requires the admin password, entered client-side).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

function renderMessagePage(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MEP Screening</title>
  <style>body{font-family:sans-serif;max-width:600px;margin:80px auto;text-align:center;color:#222}</style>
  </head><body><h2>${message}</h2></body></html>`;
}

// Candidate page calls this once, when they click "Begin". Marks the token
// as started (a reload/reopen from here on shows question 1 again but does
// NOT let them restart from scratch once they've submitted at least one
// answer — see /api/screen/:token/answer below) and returns question 1 only.
app.post('/api/screen/:token/start', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.token];
  if (!session) return res.status(404).json({ error: 'Invalid link' });
  if (session.completed) return res.status(410).json({ error: 'This link has already been used.' });

  session.started = true;
  saveSessions(sessions);

  const q = QUESTIONS.questions[session.currentQuestionIndex];
  res.json({
    question: q,
    questionNumber: session.currentQuestionIndex + 1,
    totalQuestions: QUESTIONS.questions.length
  });
});

// Candidate submits an audio answer for the CURRENT question only.
// The server decides what the next question is — the candidate's browser
// never has the full list, so there is nothing to read ahead.
app.post('/api/screen/:token/answer', upload.single('audio'), async (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.token];
  if (!session) return res.status(404).json({ error: 'Invalid link' });
  if (session.completed) return res.status(410).json({ error: 'This link has already been used.' });
  if (!req.file) return res.status(400).json({ error: 'No audio received' });

  const q = QUESTIONS.questions[session.currentQuestionIndex];
  const savedAudioPath = path.join(AUDIO_DIR, `${session.token}_q${q.id}.webm`);
  fs.renameSync(req.file.path, savedAudioPath);

  let transcript = '(transcription failed — check GROQ_API_KEY)';
  try {
    transcript = await transcribeAudio(savedAudioPath);
  } catch (err) {
    console.error('Transcription error:', err.message);
  }

  session.answers.push({ questionId: q.id, questionText: q.text, transcript });
  session.currentQuestionIndex += 1;

  const isLastQuestion = session.currentQuestionIndex >= QUESTIONS.questions.length;

  if (isLastQuestion) {
    session.completed = true; // one-time link is now permanently spent
    saveSessions(sessions);

    // Score in the background-ish (still within this request) so the
    // candidate sees a clean "thank you" without waiting on scoring errors.
    try {
      session.score = await scoreCandidate(session.candidateName, session.answers);
    } catch (err) {
      console.error('Scoring error:', err.message);
      session.score = { error: 'Scoring failed — review transcripts manually.' };
    }
    saveSessions(sessions);

    return res.json({ done: true });
  }

  saveSessions(sessions);
  const nextQ = QUESTIONS.questions[session.currentQuestionIndex];
  res.json({
    question: nextQ,
    questionNumber: session.currentQuestionIndex + 1,
    totalQuestions: QUESTIONS.questions.length
  });
});

// ============================================================
// Transcription — Groq's free Whisper endpoint
// ============================================================
async function transcribeAudio(filePath) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-large-v3-turbo');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  if (!response.ok) throw new Error(`Groq API error: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.text;
}

// ============================================================
// Scoring — Google Gemini free tier
// ============================================================
async function scoreCandidate(candidateName, answers) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const transcriptBlock = answers
    .map((a) => `Q${a.questionId}: ${a.questionText}\nA: ${a.transcript}`)
    .join('\n\n');

  const prompt = `You are screening a candidate for an MEP (Mechanical, Electrical, Plumbing) execution role on a luxury residential construction project in Delhi NCR (the "Shanti Niketan" project).

Hiring bar for this role:
- 9 to 15 years of MEP execution experience (a few years either side is acceptable for an otherwise strong candidate).
- Ideally 1-2 luxury standalone residence projects in prime Delhi localities. A five-star hotel PLUS an ultra-luxury apartment project is an acceptable alternative if no standalone residence experience exists.
- Expected salary within roughly ₹15-17 lakhs per annum.
- Must be based in or willing to relocate to Delhi NCR.

Candidate name: ${candidateName}

Interview transcript (10 questions, answered as voice notes and auto-transcribed — expect some transcription noise/informal phrasing):

${transcriptBlock}

Evaluate this candidate. Return ONLY valid JSON, no markdown, no commentary outside the JSON, in exactly this shape:
{
  "experience_fit": {"score": 1-5, "notes": "..."},
  "project_pedigree": {"score": 1-5, "notes": "..."},
  "technical_depth": {"score": 1-5, "notes": "..."},
  "communication": {"score": 1-5, "notes": "..."},
  "salary_logistics_fit": {"score": 1-5, "notes": "..."},
  "red_flags": ["...list any inconsistencies, vague answers, or concerns; empty array if none"],
  "overall_recommendation": "Advance" | "Hold" | "Reject",
  "overall_summary": "2-3 sentence plain-language summary for a recruiter to skim"
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );
  if (!response.ok) throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  const data = await response.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

app.listen(PORT, () => {
  console.log(`MEP screening agent running on http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});
