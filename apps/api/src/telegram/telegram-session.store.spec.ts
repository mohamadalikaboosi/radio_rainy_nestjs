import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { SessionCipher } from './session-cipher';
import { maskPhone, TelegramSessionStore } from './telegram-session.store';

const KEY = 'ab'.repeat(32);

describe('SessionCipher', () => {
  const c = new SessionCipher(KEY);
  it('round-trips and uses a fresh IV each time', () => {
    const a = c.encrypt('1BQANOTEuMTA=secret');
    expect(a).not.toContain('secret');
    expect(c.decrypt(a)).toBe('1BQANOTEuMTA=secret');
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });
  it('detects tampering and wrong keys', () => {
    const a = c.encrypt('hello');
    const parts = a.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => c.decrypt(parts.join(':'))).toThrow();
    expect(() => new SessionCipher('cd'.repeat(32)).decrypt(a)).toThrow();
  });
  it('rejects bad keys', () => {
    expect(() => new SessionCipher('abcd')).toThrow();
  });
});

describe('TelegramSessionStore', () => {
  let db: DatabaseService;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(() => db.onModuleDestroy());

  it('stores ciphertext only, loads plaintext, clears', async () => {
    const store = new TelegramSessionStore(db, new SessionCipher(KEY));
    expect(await store.load()).toBeNull();
    await store.save('SUPER-SECRET-SESSION', maskPhone('+989123456789'), 'admin@x.co');
    const raw = await db.query<{ ciphertext: string; account_label: string }>('SELECT * FROM telegram_session');
    expect(raw.rows[0]?.ciphertext).not.toContain('SUPER-SECRET');
    expect(raw.rows[0]?.account_label).toBe('+98*********89');
    expect(await store.load()).toBe('SUPER-SECRET-SESSION');
    await store.save('SECOND', null, null);
    expect(await store.load()).toBe('SECOND');
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
