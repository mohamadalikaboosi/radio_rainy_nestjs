import { freshDb } from '../../../test/test-db';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { SessionCipher } from '../../shared/infrastructure/crypto/session-cipher';
import { SettingsService } from './settings.service';

const KEY = 'ab'.repeat(32);

describe('SettingsService', () => {
  let db: DatabaseService;
  let svc: SettingsService;
  beforeEach(async () => {
    db = await freshDb();
    svc = new SettingsService(db, new SessionCipher(KEY, 'app-settings'));
  });
  afterEach(() => db.onModuleDestroy());

  it('stores Telegram API hash encrypted and returns it only internally', async () => {
    expect(await svc.telegram()).toBeNull();
    await svc.updateTelegram({ apiId: 12345, apiHash: 'super-secret-hash-value' }, 'admin');
    expect(await svc.telegram()).toEqual({ apiId: 12345, apiHash: 'super-secret-hash-value' });
    const raw = JSON.stringify((await db.query('SELECT * FROM app_settings')).rows);
    expect(raw).not.toContain('super-secret-hash-value');
    const v = await svc.view();
    expect(v.telegram).toEqual({ apiId: 12345, apiHashSet: true, source: 'database' });
    expect(JSON.stringify(v)).not.toContain('super-secret');
  });

  it('keeps the stored secret when the field is omitted; requires it the first time', async () => {
    await expect(svc.updateTelegram({ apiId: 1 }, 'a')).rejects.toThrow(/required/);
    await svc.updateTelegram({ apiId: 111, apiHash: 'first-hash-value' }, 'a');
    await svc.updateTelegram({ apiId: 222 }, 'a');
    expect(await svc.telegram()).toEqual({ apiId: 222, apiHash: 'first-hash-value' });
  });

  it('whisper: DB values win over env fallback; key can be cleared; disabled when url empty', async () => {
    const withEnv = new SettingsService(db, new SessionCipher(KEY, 'app-settings'), { whisper: { url: 'http://env/w', model: 'env-model' } });
    expect((await withEnv.whisper())?.url).toBe('http://env/w');
    expect((await withEnv.view()).whisper.source).toBe('environment');
    await withEnv.updateWhisper({ url: 'http://local:8000/v1/audio/transcriptions', model: 'Systran/faster-whisper-small', language: 'fa', sampleRate: 48000, timeoutSeconds: 900, apiKey: 'k1' }, 'a');
    expect(await withEnv.whisper()).toMatchObject({ url: 'http://local:8000/v1/audio/transcriptions', language: 'fa', apiKey: 'k1', sampleRate: 48000 });
    await withEnv.updateWhisper({ url: 'http://local:8000/v1/audio/transcriptions', model: 'm', language: '', sampleRate: 48000, timeoutSeconds: 900, clearApiKey: true }, 'a');
    expect((await withEnv.whisper())?.apiKey).toBeUndefined();
    expect((await withEnv.view()).whisper.apiKeySet).toBe(false);
    // empty url and no env fallback -> feature off, no error
    await svc.updateWhisper({ url: '', model: 'm', language: '', sampleRate: 48000, timeoutSeconds: 900 }, 'a');
    expect(await svc.whisper()).toBeNull();
    expect((await svc.view()).whisper.enabled).toBe(false);
  });

  it('llm is off unless enabled with a url; change listeners fire', async () => {
    const seen: string[] = [];
    svc.onChange((s) => seen.push(s));
    expect(await svc.llm()).toBeNull();
    await svc.updateLlm({ enabled: true, url: 'http://localhost:11434/v1', model: 'qwen2.5', apiKey: 'x' }, 'a');
    expect(await svc.llm()).toEqual({ enabled: true, url: 'http://localhost:11434/v1', model: 'qwen2.5', apiKey: 'x' });
    expect(seen).toEqual(['llm']);
  });

  it('ciphertext is bound to its purpose (a session blob cannot be used as settings)', async () => {
    const sessionCipher = new SessionCipher(KEY);
    const blob = sessionCipher.encrypt('{"apiHash":"forged"}');
    await db.query(`INSERT INTO app_settings (key, secret_ciphertext) VALUES ('telegram', $1)`, [blob]);
    await expect(svc.telegram()).rejects.toThrow();
  });
});
