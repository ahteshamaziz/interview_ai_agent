const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');

const MAX_SOURCE_CHARS = Number(process.env.SESSION_SOURCE_CHARS || 14000);
const MAX_RESUME_BYTES = Number(process.env.MAX_RESUME_BYTES || 8 * 1024 * 1024);

let sessionProfile = null;

function getSessionProfile() {
  return sessionProfile;
}

function clearSession() {
  sessionProfile = null;
  console.log('[session] cleared');
}

function clip(text, max = MAX_SOURCE_CHARS) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[truncated]`;
}

async function extractResumeText({ resumeText, resumeFile }) {
  if (resumeFile?.dataBase64) {
    const buffer = Buffer.from(resumeFile.dataBase64, 'base64');
    if (buffer.length > MAX_RESUME_BYTES) {
      throw new Error('Resume file is too large (max 8MB)');
    }

    const name = String(resumeFile.name || '').toLowerCase();
    const mime = String(resumeFile.mimeType || '').toLowerCase();

    if (mime.includes('pdf') || name.endsWith('.pdf')) {
      const data = await pdfParse(buffer);
      return String(data.text || '').trim();
    }
    if (mime.includes('wordprocessingml') || mime.includes('msword') || name.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer });
      return String(result.value || '').trim();
    }
    if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
      return buffer.toString('utf8').trim();
    }
    throw new Error('Unsupported resume format. Use PDF, DOCX, or TXT.');
  }

  return String(resumeText || '').trim();
}

const EXTRACT_SESSION_PROMPT = `Extract a compact interview session profile as JSON only. No markdown, no extra keys.
Schema:
{
  "roleTitle": string,
  "company": string | null,
  "seniority": "intern" | "junior" | "mid" | "senior" | "staff" | "principal" | null,
  "domain": string | null,
  "primaryLanguage": string,
  "stack": string[],
  "mustHaves": string[],
  "niceToHaves": string[],
  "candidate": {
    "name": string | null,
    "headline": string | null,
    "yearsExperience": string | null,
    "skills": string[],
    "projects": [
      { "name": string, "stack": string[], "whatYouDid": string, "impact": string | null }
    ]
  }
}
Rules:
- Use only facts in the JD and resume. Never invent employers, titles, or projects.
- primaryLanguage: the main coding language implied by the JD (JavaScript, Python, Java, TypeScript, etc.). Default JavaScript if unclear.
- Keep arrays short (max 8). Projects: the 4 most interview-relevant.
- whatYouDid: 1-2 spoken sentences the candidate can actually say.`;

function parseJsonFromModel(raw) {
  const text = String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Failed to parse session profile');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeProfile(profile, extras = {}) {
  const candidate = profile.candidate || {};
  return {
    roleTitle: String(profile.roleTitle || 'Software Engineer').trim(),
    company: profile.company ? String(profile.company).trim() : null,
    seniority: profile.seniority || null,
    domain: profile.domain ? String(profile.domain).trim() : null,
    primaryLanguage: String(profile.primaryLanguage || 'JavaScript').trim(),
    stack: Array.isArray(profile.stack) ? profile.stack.slice(0, 8).map(String) : [],
    mustHaves: Array.isArray(profile.mustHaves) ? profile.mustHaves.slice(0, 8).map(String) : [],
    niceToHaves: Array.isArray(profile.niceToHaves) ? profile.niceToHaves.slice(0, 8).map(String) : [],
    candidate: {
      name: candidate.name ? String(candidate.name).trim() : null,
      headline: candidate.headline ? String(candidate.headline).trim() : null,
      yearsExperience: candidate.yearsExperience ? String(candidate.yearsExperience).trim() : null,
      skills: Array.isArray(candidate.skills) ? candidate.skills.slice(0, 10).map(String) : [],
      projects: Array.isArray(candidate.projects)
        ? candidate.projects.slice(0, 4).map((p) => ({
            name: String(p?.name || 'Project').trim(),
            stack: Array.isArray(p?.stack) ? p.stack.slice(0, 6).map(String) : [],
            whatYouDid: String(p?.whatYouDid || '').trim(),
            impact: p?.impact ? String(p.impact).trim() : null,
          }))
        : [],
    },
    createdAt: new Date().toISOString(),
    resumeFileName: extras.resumeFileName || null,
  };
}

async function startSession({ jobDescription, resumeText, resumeFile, anthropic, model }) {
  const jd = clip(jobDescription);
  if (!jd) throw new Error('Job description is required');

  const resume = clip(await extractResumeText({ resumeText, resumeFile }));
  if (!resume) throw new Error('Resume is required');

  const t0 = Date.now();
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 1400,
    messages: [
      {
        role: 'user',
        content: `${EXTRACT_SESSION_PROMPT}\n\nJOB DESCRIPTION:\n${jd}\n\nRESUME:\n${resume}`,
      },
    ],
  });

  const raw = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const parsed = parseJsonFromModel(raw);
  sessionProfile = normalizeProfile(parsed, { resumeFileName: resumeFile?.name || null });
  console.log(
    `[session] ready in ${Date.now() - t0}ms: ${sessionProfile.roleTitle}` +
      `${sessionProfile.company ? ` @ ${sessionProfile.company}` : ''}`,
  );
  return sessionProfile;
}

function formatSessionForPrompt(profile) {
  if (!profile) return '';

  const c = profile.candidate || {};
  const projectLines = (c.projects || [])
    .map((p) => {
      const bits = [
        p.name,
        p.stack?.length ? `(${p.stack.join(', ')})` : '',
        p.whatYouDid,
        p.impact ? `Impact: ${p.impact}` : '',
      ].filter(Boolean);
      return `- ${bits.join(' — ')}`;
    })
    .join('\n');

  return [
    'SESSION CONTEXT — tailor every answer to this role and this candidate.',
    `Role: ${profile.roleTitle}${profile.company ? ` at ${profile.company}` : ''}`,
    profile.seniority ? `Seniority: ${profile.seniority}` : '',
    profile.domain ? `Domain: ${profile.domain}` : '',
    `Code language: ${profile.primaryLanguage} (use this for snippets unless the question names another language)`,
    profile.stack.length ? `Stack: ${profile.stack.join(', ')}` : '',
    profile.mustHaves.length ? `Must-haves to emphasize: ${profile.mustHaves.join(', ')}` : '',
    profile.niceToHaves.length ? `Nice-to-haves: ${profile.niceToHaves.join(', ')}` : '',
    '',
    'CANDIDATE — only use these facts; never invent jobs, employers, or projects:',
    c.name ? `Name: ${c.name}` : '',
    c.headline ? `Headline: ${c.headline}` : '',
    c.yearsExperience ? `Experience: ${c.yearsExperience}` : '',
    c.skills?.length ? `Skills: ${c.skills.join(', ')}` : '',
    projectLines ? `Projects:\n${projectLines}` : '',
    '',
    'When giving a spoken example, prefer a resume project that maps to the question.',
    'If none maps, use a generic example and do not pretend it is the candidate\'s experience.',
    'Match the seniority of the role: junior = clear definitions; senior/staff = trade-offs and ownership.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

module.exports = {
  getSessionProfile,
  clearSession,
  startSession,
  formatSessionForPrompt,
};
