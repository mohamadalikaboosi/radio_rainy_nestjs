import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage, useAsync } from '../hooks';
import { Badge, Card, ErrorBox } from '../ui';

interface View {
  telegram: { apiId: number | null; apiHashSet: boolean; source: string };
  whisper: { url: string; model: string; language: string; sampleRate: number; timeoutSeconds: number; apiKeySet: boolean; enabled: boolean; source: string };
  llm: { enabled: boolean; url: string; model: string; apiKeySet: boolean };
}

function useSave(reload: () => void) {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (path: string, body: unknown, ok: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await api(path, { method: 'PUT', body });
      setMsg(ok);
      reload();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { msg, err, busy, save };
}

function TelegramForm({ v, reload }: { v: View['telegram']; reload: () => void }) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const s = useSave(reload);
  useEffect(() => setApiId(v.apiId ? String(v.apiId) : ''), [v.apiId]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void s.save('/admin/settings/telegram', { apiId: Number(apiId), ...(apiHash ? { apiHash } : {}) }, 'Saved. Reconnecting to Telegram…').then(() => setApiHash(''));
  };
  return (
    <Card title="Telegram API" actions={<Badge tone={v.apiHashSet ? 'good' : 'warn'}>{v.apiHashSet ? `set (${v.source})` : 'not set'}</Badge>}>
      <p className="muted">From <a href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a> → API development tools. The hash is stored <b>encrypted</b> in the database and can never be shown again.</p>
      <form className="row wrap" onSubmit={submit}>
        <label>API ID <input value={apiId} onChange={(e) => setApiId(e.target.value)} inputMode="numeric" required /></label>
        <label>API hash {v.apiHashSet && <small>(leave empty to keep the current one)</small>}<input type="password" value={apiHash} onChange={(e) => setApiHash(e.target.value)} autoComplete="off" placeholder={v.apiHashSet ? '••••••••••••••••' : ''} required={!v.apiHashSet} /></label>
        <button className="btn btn-primary" disabled={s.busy}>Save</button>
      </form>
      {s.msg && <div className="alert alert-good">{s.msg}</div>}
      <ErrorBox error={s.err} />
    </Card>
  );
}

function WhisperForm({ v, reload }: { v: View['whisper']; reload: () => void }) {
  const [f, setF] = useState({ url: '', model: 'whisper-1', language: '', sampleRate: 48000, timeoutSeconds: 900, apiKey: '' });
  const s = useSave(reload);
  useEffect(() => setF((x) => ({ ...x, url: v.url, model: v.model, language: v.language, sampleRate: v.sampleRate, timeoutSeconds: v.timeoutSeconds })), [v.url, v.model, v.language, v.sampleRate, v.timeoutSeconds]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const { apiKey, ...rest } = f;
    void s.save('/admin/settings/whisper', { ...rest, ...(apiKey ? { apiKey } : {}) }, rest.url ? 'Saved. New songs will be transcribed with these settings.' : 'Saved. AI lyrics sync is OFF.').then(() => setF((x) => ({ ...x, apiKey: '' })));
  };
  return (
    <Card title="Whisper (speech-to-text)" actions={<Badge tone={v.enabled ? 'good' : 'neutral'}>{v.enabled ? `on (${v.source})` : 'off'}</Badge>}>
      <p className="muted">Any OpenAI-compatible endpoint (local <b>Speaches / faster-whisper</b>, whisper.cpp server, OpenAI…). Leave the URL empty to turn AI lyrics synchronization off. Audio is sent at the sample rate below.</p>
      <form className="stack" onSubmit={submit}>
        <div className="row wrap">
          <label className="grow">Endpoint URL <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://localhost:8000/v1/audio/transcriptions" /></label>
          <label>Model <input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="Systran/faster-whisper-small" /></label>
          <label>Language hint <input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder="auto (fa / en)" size={8} /></label>
        </div>
        <div className="row wrap">
          <label>Sample rate (Hz) <input type="number" value={f.sampleRate} onChange={(e) => setF({ ...f, sampleRate: Number(e.target.value) })} /></label>
          <label>Timeout (s) <input type="number" value={f.timeoutSeconds} onChange={(e) => setF({ ...f, timeoutSeconds: Number(e.target.value) })} /></label>
          <label>API key {v.apiKeySet && <small>(set — leave empty to keep)</small>}<input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="off" /></label>
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={s.busy}>Save</button>
          {v.apiKeySet && <button type="button" className="btn btn-danger" onClick={() => void s.save('/admin/settings/whisper', { ...f, apiKey: undefined, clearApiKey: true }, 'API key removed.')}>Remove API key</button>}
        </div>
      </form>
      {s.msg && <div className="alert alert-good">{s.msg}</div>}
      <ErrorBox error={s.err} />
    </Card>
  );
}

function LlmForm({ v, reload }: { v: View['llm']; reload: () => void }) {
  const [f, setF] = useState({ enabled: false, url: '', model: '', apiKey: '' });
  const s = useSave(reload);
  useEffect(() => setF((x) => ({ ...x, enabled: v.enabled, url: v.url, model: v.model })), [v.enabled, v.url, v.model]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const { apiKey, ...rest } = f;
    void s.save('/admin/settings/llm', { ...rest, ...(apiKey ? { apiKey } : {}) }, 'Saved.').then(() => setF((x) => ({ ...x, apiKey: '' })));
  };
  return (
    <Card title="Language model (LLM) — Persian & English" actions={<Badge tone={v.enabled ? 'good' : 'neutral'}>{v.enabled ? 'on' : 'off'}</Badge>}>
      <p className="muted">Optional. Used on the Language page to review spellings the system has learned from your songs. Any OpenAI-compatible chat API (Ollama, LM Studio, vLLM, OpenAI…).</p>
      <form className="stack" onSubmit={submit}>
        <label className="radio-line"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enable</label>
        <div className="row wrap">
          <label className="grow">Base URL <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="http://localhost:11434/v1" /></label>
          <label>Model <input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="qwen2.5:7b" /></label>
          <label>API key {v.apiKeySet && <small>(set — leave empty to keep)</small>}<input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="off" /></label>
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={s.busy}>Save</button>
          {v.apiKeySet && <button type="button" className="btn btn-danger" onClick={() => void s.save('/admin/settings/llm', { enabled: f.enabled, url: f.url, model: f.model, clearApiKey: true }, 'API key removed.')}>Remove API key</button>}
        </div>
      </form>
      {s.msg && <div className="alert alert-good">{s.msg}</div>}
      <ErrorBox error={s.err} />
    </Card>
  );
}

export function Settings() {
  const { data, error, reload } = useAsync(() => api<View>('/admin/settings'), []);
  if (!data) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <ErrorBox error={error} />
      <p className="muted">These settings live in the database (secrets are encrypted with your <code>TELEGRAM_SESSION_ENCRYPTION_KEY</code>) and apply immediately — no redeploy. Environment variables are only a fallback.</p>
      <TelegramForm v={data.telegram} reload={reload} />
      <WhisperForm v={data.whisper} reload={reload} />
      <LlmForm v={data.llm} reload={reload} />
    </div>
  );
}
