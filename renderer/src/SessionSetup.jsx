import { useRef, useState } from 'react';

const ACCEPT = '.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read resume file'));
    reader.readAsDataURL(file);
  });
}

function isResumeFile(file) {
  const name = (file?.name || '').toLowerCase();
  const type = (file?.type || '').toLowerCase();
  return (
    type.includes('pdf') ||
    type.includes('wordprocessingml') ||
    type.startsWith('text/') ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.txt') ||
    name.endsWith('.md')
  );
}

export default function SessionSetup({ backendUrl, onStarted }) {
  const [jobDescription, setJobDescription] = useState('');
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeText, setResumeText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  function chooseFile(file) {
    if (!file) return;
    if (!isResumeFile(file)) {
      setError('Use a PDF, DOCX, or TXT resume.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('Resume is too large (max 8MB).');
      return;
    }
    setError('');
    setResumeFile(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    chooseFile(e.dataTransfer.files?.[0]);
  }

  async function startSession() {
    const jd = jobDescription.trim();
    if (!jd) {
      setError('Paste the job description first.');
      return;
    }
    if (!resumeFile && !resumeText.trim()) {
      setError('Upload a resume (or paste the text).');
      return;
    }

    setIsStarting(true);
    setError('');
    try {
      const body = { jobDescription: jd };
      if (resumeFile) {
        body.resumeFile = {
          name: resumeFile.name,
          mimeType: resumeFile.type,
          dataBase64: await fileToBase64(resumeFile),
        };
      } else {
        body.resumeText = resumeText.trim();
      }

      const res = await fetch(`${backendUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'Could not start session');
      onStarted(payload.profile);
    } catch (err) {
      setError(err.message || 'Could not start session');
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div className="session-setup">
      <div className="session-setup-intro">
        <h2>Start interview session</h2>
        <p>Paste the job description and upload your resume. Answers will use this role and your real projects.</p>
      </div>

      <label className="session-field">
        <span>Job description</span>
        <textarea
          className="text-input session-jd"
          placeholder="Paste the full job description here..."
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          rows={8}
          disabled={isStarting}
        />
      </label>

      <div className="session-field">
        <span>Resume</span>
        <div
          className={`resume-drop ${dragOver ? 'is-over' : ''} ${resumeFile ? 'has-file' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => {
            if (!isStarting) fileInputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            hidden
            disabled={isStarting}
            onChange={(e) => chooseFile(e.target.files?.[0])}
          />
          {resumeFile ? (
            <>
              <strong>{resumeFile.name}</strong>
              <em>Click to replace</em>
            </>
          ) : (
            <>
              <strong>Drop PDF, DOCX, or TXT</strong>
              <em>or click to upload</em>
            </>
          )}
        </div>
        <textarea
          className="text-input session-resume-paste"
          placeholder="Or paste resume text here..."
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          rows={3}
          disabled={isStarting || Boolean(resumeFile)}
        />
      </div>

      {error ? <div className="session-error">{error}</div> : null}

      <button
        className="session-start-btn"
        type="button"
        onClick={startSession}
        disabled={isStarting}
      >
        {isStarting ? 'Building session…' : 'Start session'}
      </button>
    </div>
  );
}
