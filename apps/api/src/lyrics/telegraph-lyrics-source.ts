import { Injectable, Logger } from '@nestjs/common';
import { LyricsError } from './lyrics.errors';
import { LyricsSource } from './lyrics-source';
import { htmlToText, nodesToText, TgNode } from './telegraph-parser';

const ALLOWED_HOSTS = new Set(['telegra.ph', 'te.legra.ph', 'graph.org']);

interface TelegraphApiResponse {
  ok: boolean;
  error?: string;
  result?: { content?: TgNode[] };
}

export function telegraphPathFromUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LyricsError('INVALID_URL', 'Not a valid URL');
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new LyricsError('INVALID_URL', 'Only https Telegraph URLs are allowed');
  }
  const path = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ''));
  if (path.length === 0 || path.includes('/')) throw new LyricsError('INVALID_URL', 'Telegraph page path missing');
  return path;
}

export type FetchFn = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

@Injectable()
export class TelegraphLyricsSource implements LyricsSource {
  private readonly logger = new Logger(TelegraphLyricsSource.name);

  constructor(private readonly fetchFn: FetchFn = (i, init) => fetch(i, init), private readonly timeoutMs = 10_000) {}

  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    const path = telegraphPathFromUrl(url);
    let text: string;
    try {
      text = await this.viaApi(path, signal);
    } catch (err) {
      if (err instanceof LyricsError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_URL' || err.code === 'EMPTY')) throw err;
      this.logger.warn({ msg: 'telegraph api failed, falling back to html', path, err: String(err) });
      text = await this.viaHtml(url, signal);
    }
    if (text.trim().length === 0) throw new LyricsError('EMPTY', 'Telegraph page has no lyrics text');
    return text;
  }

  private timeoutSignal(outer?: AbortSignal): AbortSignal {
    const t = AbortSignal.timeout(this.timeoutMs);
    return outer ? AbortSignal.any([outer, t]) : t;
  }

  private async viaApi(path: string, signal?: AbortSignal): Promise<string> {
    const endpoint = `https://api.telegra.ph/getPage/${encodeURIComponent(path)}?return_content=true`;
    let res;
    try {
      res = await this.fetchFn(endpoint, { signal: this.timeoutSignal(signal) });
    } catch (err) {
      throw new LyricsError('NETWORK', `Telegraph API unreachable: ${String(err)}`);
    }
    let body: TelegraphApiResponse;
    try {
      body = (await res.json()) as TelegraphApiResponse;
    } catch {
      throw new LyricsError('PARSE', `Telegraph API returned non-JSON (status ${res.status})`);
    }
    if (!body.ok) {
      if (/NOT_FOUND|PAGE_NOT_FOUND/i.test(body.error ?? '') || res.status === 404) {
        throw new LyricsError('NOT_FOUND', 'Telegraph page not found');
      }
      throw new LyricsError('PARSE', `Telegraph API error: ${body.error ?? res.status}`);
    }
    return nodesToText(body.result?.content ?? []);
  }

  private async viaHtml(url: string, signal?: AbortSignal): Promise<string> {
    let res;
    try {
      res = await this.fetchFn(url, { signal: this.timeoutSignal(signal), headers: { Accept: 'text/html' } });
    } catch (err) {
      throw new LyricsError('NETWORK', `Telegraph unreachable: ${String(err)}`);
    }
    if (res.status === 404) throw new LyricsError('NOT_FOUND', 'Telegraph page not found');
    if (!res.ok) throw new LyricsError('NETWORK', `Telegraph HTTP ${res.status}`);
    return htmlToText(await res.text());
  }
}
