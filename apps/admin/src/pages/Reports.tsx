import { ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadWithAuth } from '../api';
import { useChannels } from '../channel-context';
import { ColumnChart, HBars, LineChart, Legend, SegmentBar, TableView, fmtDuration, fmtInt, pct } from '../charts';
import { LYRICS_LABEL, timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

type Range = '24h' | '7d' | '30d' | '90d';

interface Report {
  range: Range;
  generatedAt: string;
  summary: {
    plays: number; uniqueTracks: number; airtimeSeconds: number; skipRate: number; errorRate: number;
    outcomes: { finished: number; skipped: number; admin: number; errors: number };
    audience: { averageListeners: number; peakListeners: number; listenerMinutes: number };
  };
  timeseries: { bucket: 'hour' | 'day'; points: { t: string; plays: number; errors: number; averageListeners: number; peakListeners: number }[] };
  top: { tracks: { id: string; title: string; artist: string | null; plays: number; skips: number }[]; artists: { artist: string; plays: number }[]; hashtags: { hashtag: string; plays: number }[] };
  lyrics: {
    byStatus: { status: string; tracks: number }[]; byLanguage: { language: string; tracks: number }[]; failureReasons: { reason: string; tracks: number }[];
    quality: { average: number | null; distribution: { bucket: string; tracks: number }[] }; coverage: { withUrl: number; synced: number };
  };
  library: {
    channels: { id: string; title: string; tracks: number; playable: number; disabled: number; failed: number; unavailable: number; totalSeconds: number; neverPlayed: number; plays: number }[];
    problemTracks: { id: string; title: string; artist: string | null; status: string; consecutiveFailures: number; lyricsStatus: string; lyricsError: string | null }[];
    recentErrors: { at: string; trackId: string; title: string; artist: string | null }[];
  };
}

interface Health {
  process: { uptimeSeconds: number; node: string; memoryMb: number };
  database: { ok: boolean; latencyMs: number; sizeMb: number };
  telegram: { state: string; accountLabel: string | null };
  queues: Record<string, Record<string, number>> | null;
  integrations: { whisper: boolean; llm: boolean; audioCache: boolean };
  audioCache: { configured: boolean; objects?: number; bytes?: number; error?: string };
  stations: { id: string; title: string; running: boolean; listeners: number; live: { enabled: boolean; status: string } }[];
}

const RANGES: { id: Range; label: string }[] = [{ id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }, { id: '90d', label: '90 days' }];

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return <div className="kpi"><div className="kpi-value">{value}</div><div className="kpi-label">{label}</div>{hint && <div className="kpi-hint">{hint}</div>}</div>;
}

function labelFor(iso: string, bucket: 'hour' | 'day', range: Range): string {
  const d = new Date(iso);
  if (bucket === 'day') return `${d.getMonth() + 1}/${d.getDate()}`;
  return range === '24h' ? `${String(d.getHours()).padStart(2, '0')}:00` : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
}
const tipFor = (iso: string, bucket: 'hour' | 'day'): string => (bucket === 'day' ? new Date(iso).toLocaleDateString() : new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

function Health() {
  const { data, error } = useAsync(() => api<Health>('/admin/reports/system'), [], 30_000);
  if (!data) return <ErrorBox error={error} />;
  const tone = (ok: boolean): 'good' | 'bad' => (ok ? 'good' : 'bad');
  const q = data.queues ?? {};
  return (
    <div className="health">
      <div className="kpi"><b>Database</b><Badge tone={tone(data.database.ok)}>{data.database.ok ? 'OK' : 'DOWN'}</Badge><span className="kpi-hint">{data.database.latencyMs} ms · {data.database.sizeMb} MB</span></div>
      <div className="kpi"><b>Telegram</b><Badge tone={data.telegram.state === 'READY' ? 'good' : 'warn'}>{data.telegram.state}</Badge><span className="kpi-hint">{data.telegram.accountLabel ?? 'no account'}</span></div>
      <div className="kpi"><b>Server</b><span>up {fmtDuration(data.process.uptimeSeconds)}</span><span className="kpi-hint">{data.process.memoryMb} MB RAM · Node {data.process.node}</span></div>
      <div className="kpi"><b>Integrations</b><span><Badge tone={data.integrations.whisper ? 'good' : 'neutral'}>Whisper {data.integrations.whisper ? 'on' : 'off'}</Badge> <Badge tone={data.integrations.llm ? 'good' : 'neutral'}>LLM {data.integrations.llm ? 'on' : 'off'}</Badge></span>
        <span className="kpi-hint">{data.audioCache.configured ? (data.audioCache.error ? `Audio cache error: ${data.audioCache.error}` : `Audio cache: ${fmtInt(data.audioCache.objects ?? 0)} tracks · ${fmtInt((data.audioCache.bytes ?? 0) / 1_048_576)} MB`) : 'Audio cache off'}</span></div>
      <div className="kpi"><b>Job queues</b>{Object.entries(q).map(([name, c]) => <span key={name} className="kpi-hint">{name}: {c.waiting ?? 0} waiting · {c.active ?? 0} active · {c.delayed ?? 0} delayed · <span style={{ color: (c.failed ?? 0) > 0 ? 'var(--status-critical)' : undefined }}>{(c.failed ?? 0) > 0 ? '✕ ' : ''}{c.failed ?? 0} failed</span></span>)}</div>
      <div className="kpi"><b>Stations</b>{data.stations.map((s) => <span key={s.id} className="kpi-hint">{s.title}: {s.running ? 'on air' : 'off'} · {s.listeners} listening{s.live.enabled ? ` · Telegram ${s.live.status}` : ''}</span>)}</div>
    </div>
  );
}

export function Reports() {
  const { channels } = useChannels();
  const [range, setRange] = useState<Range>('7d');
  const [channel, setChannel] = useState<string>('');
  const { data, error, reload } = useAsync(() => api<Report>('/admin/reports', { query: { range, channel } }), [range, channel]);
  const r = data;
  const scope = channel ? channels.find((c) => c.id === channel)?.title ?? 'channel' : 'All channels';
  const ts = r?.timeseries;
  const labels = ts?.points.map((p) => labelFor(p.t, ts.bucket, range)) ?? [];
  const tips = ts?.points.map((p) => tipFor(p.t, ts.bucket)) ?? [];
  const o = r?.summary.outcomes;

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Reports</h1><span className="muted">{scope} · last {RANGES.find((x) => x.id === range)?.label}{r ? ` · generated ${timeAgo(r.generatedAt)}` : ''}</span></div>
        <div className="row wrap">
          <div className="segmented" role="group" aria-label="period">{RANGES.map((x) => <button key={x.id} aria-pressed={range === x.id} onClick={() => setRange(x.id)}>{x.label}</button>)}</div>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="report channel"><option value="">All channels</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
          <button className="btn" onClick={reload}>Refresh</button>
          <ActionButton onAction={() => downloadWithAuth(`/admin/reports/export.csv?type=plays&range=${range}${channel ? `&channel=${channel}` : ''}`, `plays_${range}.csv`)}>⬇ Plays CSV</ActionButton>
          <ActionButton onAction={() => downloadWithAuth(`/admin/reports/export.csv?type=tracks${channel ? `&channel=${channel}` : ''}`, 'tracks.csv')}>⬇ Tracks CSV</ActionButton>
        </div>
      </div>
      <ErrorBox error={error} />

      {r && (
        <>
          <div className="kpis">
            <Kpi label="Plays" value={fmtInt(r.summary.plays)} hint={`${fmtInt(r.summary.uniqueTracks)} different tracks`} />
            <Kpi label="Airtime" value={fmtDuration(r.summary.airtimeSeconds)} hint="music broadcast" />
            <Kpi label="Avg listeners" value={r.summary.audience.averageListeners} hint="sampled every 30 s" />
            <Kpi label="Peak listeners" value={fmtInt(r.summary.audience.peakListeners)} />
            <Kpi label="Listener minutes" value={fmtInt(r.summary.audience.listenerMinutes)} hint="total listening time" />
            <Kpi label="Skip rate" value={pct(r.summary.skipRate)} hint={`${fmtInt(r.summary.outcomes.skipped)} skipped`} />
            <Kpi label="Error rate" value={pct(r.summary.errorRate)} hint={`${fmtInt(r.summary.outcomes.errors)} failed plays`} />
            <Kpi label="Lyrics synced" value={`${fmtInt(r.lyrics.coverage.synced)} / ${fmtInt(r.lyrics.coverage.withUrl)}`} hint="tracks with a lyrics link" />
          </div>

          <Card title="Plays over time">
            <ColumnChart ariaLabel="Plays per period" points={ts?.points.map((p, i) => ({ label: labels[i] ?? '', tip: tips[i] ?? '', value: p.plays })) ?? []} unit=" plays" />
            <TableView columns={[{ key: 't', label: 'Period' }, { key: 'plays', label: 'Plays' }, { key: 'errors', label: 'Errors' }]} rows={(ts?.points ?? []).map((p, i) => ({ t: tips[i], plays: p.plays, errors: p.errors }))} />
          </Card>

          <Card title="Audience">
            <Legend items={[{ label: 'Average listeners', color: 'var(--series-1)' }, { label: 'Peak listeners', color: 'var(--series-2)' }]} />
            <LineChart ariaLabel="Listeners over time" labels={labels} tips={tips} series={[{ name: 'Average', color: 'var(--series-1)', values: ts?.points.map((p) => p.averageListeners) ?? [] }, { name: 'Peak', color: 'var(--series-2)', values: ts?.points.map((p) => p.peakListeners) ?? [] }]} />
            <TableView columns={[{ key: 't', label: 'Period' }, { key: 'avg', label: 'Average' }, { key: 'peak', label: 'Peak' }]} rows={(ts?.points ?? []).map((p, i) => ({ t: tips[i], avg: p.averageListeners, peak: p.peakListeners }))} />
          </Card>

          <div className="grid-2">
            <Card title="How plays ended">
              <SegmentBar segments={[
                { label: 'Finished', value: o?.finished ?? 0, color: 'var(--series-1)' },
                { label: 'Skipped by admin/next', value: (o?.skipped ?? 0), color: 'var(--series-2)' },
                { label: 'Played on request', value: o?.admin ?? 0, color: 'var(--series-3)' },
                { label: 'Failed', value: o?.errors ?? 0, color: 'var(--status-critical)', icon: '✕' },
              ]} />
            </Card>
            <Card title="Lyrics quality (alignment coverage)">
              <ColumnChart height={150} ariaLabel="Tracks by lyrics alignment quality" points={r.lyrics.quality.distribution.map((d) => ({ label: d.bucket, tip: `quality ${d.bucket}`, value: d.tracks }))} unit=" tracks" />
              <p className="muted">Average quality: {r.lyrics.quality.average === null ? '—' : pct(r.lyrics.quality.average)}</p>
              <TableView columns={[{ key: 'b', label: 'Quality' }, { key: 'n', label: 'Tracks' }]} rows={r.lyrics.quality.distribution.map((d) => ({ b: d.bucket, n: d.tracks }))} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Top tracks"><HBars items={r.top.tracks.map((t) => ({ label: <Link to={`/panel/tracks/${t.id}`}>{t.artist ? `${t.artist} – ` : ''}{t.title}</Link>, value: t.plays, hint: `${t.skips} skipped` }))} /></Card>
            <Card title="Top artists"><HBars color="var(--series-2)" items={r.top.artists.map((a) => ({ label: a.artist, value: a.plays }))} /></Card>
            <Card title="Top hashtags"><HBars color="var(--series-3)" items={r.top.hashtags.map((h) => ({ label: `#${h.hashtag}`, value: h.plays }))} /></Card>
            <Card title="Lyrics status">
              <HBars items={r.lyrics.byStatus.map((s) => ({ label: LYRICS_LABEL[s.status] ?? s.status, value: s.tracks }))} />
              <h3>Languages</h3>
              <HBars color="var(--series-2)" items={r.lyrics.byLanguage.map((l) => ({ label: l.language === 'fa' ? 'Persian' : l.language === 'en' ? 'English' : l.language, value: l.tracks }))} />
              {r.lyrics.failureReasons.length > 0 && (<><h3>Why lyrics failed</h3><HBars color="var(--status-critical)" items={r.lyrics.failureReasons.map((f) => ({ label: `✕ ${f.reason}`, value: f.tracks }))} /></>)}
            </Card>
          </div>

          <Card title="Library">
            <div className="table-wrap"><table>
              <thead><tr><th>Channel</th><th>Tracks</th><th>Playable</th><th>Disabled</th><th>Failed</th><th>Deleted on Telegram</th><th>Duration</th><th>Never played</th><th>Total plays</th></tr></thead>
              <tbody>{r.library.channels.map((c) => <tr key={c.id}><td>{c.title}</td><td>{fmtInt(c.tracks)}</td><td>{fmtInt(c.playable)}</td><td>{fmtInt(c.disabled)}</td><td>{c.failed > 0 ? `✕ ${c.failed}` : 0}</td><td>{c.unavailable}</td><td>{fmtDuration(c.totalSeconds)}</td><td>{fmtInt(c.neverPlayed)}</td><td>{fmtInt(c.plays)}</td></tr>)}
                {r.library.channels.length === 0 && <tr><td colSpan={9} className="muted">No channels.</td></tr>}</tbody>
            </table></div>
          </Card>

          <div className="grid-2">
            <Card title="Tracks that need attention">
              <div className="table-wrap"><table>
                <thead><tr><th>Track</th><th>Audio</th><th>Lyrics</th></tr></thead>
                <tbody>{r.library.problemTracks.map((t) => <tr key={t.id}><td><Link to={`/panel/tracks/${t.id}`}>{t.artist ? `${t.artist} – ` : ''}{t.title}</Link></td><td>{t.status !== 'READY' ? <Badge tone="bad">✕ {t.status}</Badge> : t.consecutiveFailures > 0 ? <Badge tone="warn">{t.consecutiveFailures} recent failures</Badge> : <Badge tone="good">OK</Badge>}</td><td>{t.lyricsStatus === 'LYRICS_FAILED' ? <Badge tone="bad">✕ {t.lyricsError ?? 'failed'}</Badge> : LYRICS_LABEL[t.lyricsStatus]}</td></tr>)}
                  {r.library.problemTracks.length === 0 && <tr><td colSpan={3} className="muted">Nothing needs attention.</td></tr>}</tbody>
              </table></div>
            </Card>
            <Card title="Recent playback errors">
              <ul className="mini-list">{r.library.recentErrors.map((e, i) => <li key={i}><span><Link to={`/panel/tracks/${e.trackId}`}>{e.artist ? `${e.artist} – ` : ''}{e.title}</Link></span><small className="muted">{timeAgo(e.at)}</small></li>)}
                {r.library.recentErrors.length === 0 && <li className="muted">No errors.</li>}</ul>
            </Card>
          </div>
        </>
      )}

      <Card title="System health"><Health /></Card>
      {!r && !error && <p className="muted">Loading report…</p>}
    </div>
  );
}
