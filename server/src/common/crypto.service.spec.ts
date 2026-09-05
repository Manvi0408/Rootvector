import { CryptoService } from './crypto.service';

/**
 * Unit tests for the AES-256-GCM token encryption used to store provider
 * credentials at rest. These are pure (no DB / network) — they exercise the
 * round-trip, the random IV, key validation, and GCM tamper detection.
 */
describe('CryptoService', () => {
  const KEY_HEX = '0'.repeat(64); // 32 bytes of zeros, as hex
  let service: CryptoService;
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY_HEX;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    else process.env.INTEGRATIONS_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(() => {
    service = new CryptoService();
  });

  it('decrypts what it encrypts (round-trip)', () => {
    const plain = 'ghp_secretProviderToken_1234567890';
    expect(service.decrypt(service.encrypt(plain))).toBe(plain);
  });

  it('handles unicode and empty strings', () => {
    for (const plain of ['', 'हिन्दी 🚀 — token', 'a'.repeat(5000)]) {
      expect(service.decrypt(service.encrypt(plain))).toBe(plain);
    }
  });

  it('produces a different ciphertext each time (random IV) but the same plaintext', () => {
    const plain = 'same-input';
    const a = service.encrypt(plain);
    const b = service.encrypt(plain);
    expect(a).not.toBe(b); // random 12-byte IV per call
    expect(service.decrypt(a)).toBe(service.decrypt(b));
  });

  it('emits the iv:tag:data format', () => {
    const parts = service.encrypt('x').split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24); // 12-byte IV as hex
    expect(parts[1]).toHaveLength(32); // 16-byte GCM tag as hex
  });

  it('rejects a tampered payload (GCM authentication)', () => {
    const [iv, tag, data] = service.encrypt('trust me').split(':');
    const flipped = (data[0] === 'a' ? 'b' : 'a') + data.slice(1);
    expect(() => service.decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('throws when the key is not 32 bytes', () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = 'deadbeef'; // 4 bytes
    expect(() => new CryptoService().encrypt('x')).toThrow(/32 bytes/);
    process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY_HEX; // restore for other tests
  });
});
