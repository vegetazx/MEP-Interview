# MEP First-Round Screening Agent

A zero-subscription tool that sends a candidate 10 questions one at a time over a
single-use link, records their voice answers, transcribes them, and scores fit
against the MEP hiring bar — so you see a scorecard before spending human interview time.

This document assumes no coding background. Follow it top to bottom once, in order.

## What you need before starting (all free)

1. **A Groq account** — free API key, used to convert voice notes to text.
   Sign up at https://console.groq.com → create an API key.
2. **A Google AI Studio account** — free API key, used to score the transcript.
   Sign up at https://aistudio.google.com/app/apikey → create an API key.
3. **A Render.com account** (free tier) — this is where the tool will actually run,
   so it works without your own computer being on. Sign up at https://render.com
   (you can sign up with GitHub or Google, no card required for the free tier).
4. **A GitHub account** (free) — Render deploys from a GitHub repository.

## Step 1 — Put this project on GitHub

1. Go to https://github.com/new, create a new **private** repository (e.g. `mep-screening-agent`).
2. On your computer, unzip the project folder you were given.
3. Upload all the files in it to that new GitHub repository (GitHub's website
   has an "upload files" button — drag the whole folder's contents in, except
   the `node_modules` folder if present, and except any `.env` file).

## Step 2 — Deploy it on Render (free)

1. In Render, click **New → Web Service**, connect your GitHub account, and pick
   the repository you just created.
2. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
3. Under **Environment Variables**, add these three (values from the accounts above):
   - `GROQ_API_KEY` — paste your Groq key
   - `GEMINI_API_KEY` — paste your Gemini key
   - `ADMIN_PASSWORD` — make up your own password; this protects the admin dashboard
4. Click **Create Web Service**. Render will give you a live URL like
   `https://mep-screening-agent.onrender.com` — that's your tool's address.

Note: on Render's free tier, the app "sleeps" after 15 minutes of no traffic and
takes ~30-50 seconds to wake up on the next request. At under 20 candidates/month
this is a non-issue — worth knowing so a candidate's first click isn't mistaken
for the link being broken.

## Step 3 — Screen a candidate

1. Go to `https://<your-render-url>/admin`, enter your admin password.
2. Type the candidate's name (and phone, optional) → **Generate link**.
3. Send that link to the candidate over WhatsApp, email, or SMS — however you'd
   normally reach them. It works exactly once.
4. Once they complete it (10 short voice answers, ~10-15 minutes), refresh the
   admin dashboard. You'll see: their transcript-based scores across five
   dimensions, any red flags the AI noticed, and an Advance / Hold / Reject
   recommendation with a plain-language summary.
5. This is a *first-pass filter, not a final decision* — use it to prioritize
   who gets a human interview next, not to auto-reject anyone without a look.

## What's inside this folder

| File | What it does |
|---|---|
| `server.js` | The whole backend — link creation, one-time-use enforcement, transcription, scoring |
| `questions.json` | The 10 screening questions. Edit this file's text to change the questions — no need to touch `server.js`. Reuse this same project for other roles by swapping this file's questions and the rubric text inside `server.js`'s `scoreCandidate` function. |
| `views/screen.html` | What the candidate sees |
| `views/admin.html` | What you see (link creation + results table) |
| `results/sessions.json` | Where every candidate's transcript and score gets saved |

## Adapting this for other roles later

You mentioned this could extend beyond MEP if it works well. To do that:

1. Duplicate this whole project folder (or just `questions.json` and the rubric
   text) for the new role.
2. Replace the 10 questions in `questions.json` with ones relevant to that role.
3. Update the hiring-bar paragraph inside the `scoreCandidate` function in
   `server.js` (currently describes the MEP bar: experience years, project
   pedigree, salary band, locality) to match the new role's bar.
4. Deploy as a second Render service (or reuse this one and swap the files
   between hiring rounds — either works at this volume).

## Honest limits of this tool

- **It cannot fully stop a candidate from being coached off-screen** — a second
  device or a person feeding them answers out of camera view is not detectable
  by a browser recording tool. What it *does* stop: seeing the question list in
  advance, going back to redo an answer, and reusing/forwarding the link.
- **Free tiers have quotas.** At under ~20 candidates/month you should be
  comfortably inside Groq's and Gemini's free limits, but if volume grows a lot,
  check their current free-tier limits (they change over time) before assuming
  it's still free.
- **The AI score is a first-pass signal, not a hiring decision.** Always spot-check
  a few transcripts against the score, especially early on, to confirm the
  rubric is calibrated the way you want.
