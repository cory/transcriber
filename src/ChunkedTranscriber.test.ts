import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock modules before importing anything that uses them
jest.unstable_mockModule('fs', () => ({
  statSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.unstable_mockModule('child_process', () => ({
  exec: jest.fn((cmd: any, callback: any) => {
    if (callback) callback(null, { stdout: '', stderr: '' });
  }),
}));

jest.unstable_mockModule('ora', () => ({
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: '',
  })),
}));

jest.unstable_mockModule('chalk', () => ({
  default: {
    cyan: jest.fn((str: any) => str),
    green: jest.fn((str: any) => str),
    red: jest.fn((str: any) => str),
    gray: jest.fn((str: any) => str),
  },
}));

jest.unstable_mockModule('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn(),
    },
  })),
}));

// Import after mocks are set up
const fs = await import('fs');
const ChunkedTranscriberModule = await import('./ChunkedTranscriber');

describe('ChunkedTranscriber', () => {
  let transcriber: InstanceType<typeof ChunkedTranscriberModule.ChunkedTranscriber>;
  const mockApiKey = 'test-api-key';

  beforeEach(() => {
    transcriber = new ChunkedTranscriberModule.ChunkedTranscriber({ apiKey: mockApiKey });
    jest.clearAllMocks();
  });

  describe('calculateFileHash', () => {
    it('should generate consistent hash for same file stats', async () => {
      const testPath = '/test/audio.mp3';
      const mockStats = {
        size: 1024000,
        mtime: new Date('2024-01-01T00:00:00Z')
      };

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValue(mockStats as any);

      const hash1 = await transcriber.calculateFileHash(testPath);
      const hash2 = await transcriber.calculateFileHash(testPath);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{32}$/);
    });

    it('should generate different hashes for different file sizes', async () => {
      const testPath = '/test/audio.mp3';

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValueOnce({
        size: 1024000,
        mtime: new Date('2024-01-01T00:00:00Z')
      } as any);

      const hash1 = await transcriber.calculateFileHash(testPath);

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValueOnce({
        size: 2048000,
        mtime: new Date('2024-01-01T00:00:00Z')
      } as any);

      const hash2 = await transcriber.calculateFileHash(testPath);

      expect(hash1).not.toBe(hash2);
    });

    it('should generate different hashes for different modification times', async () => {
      const testPath = '/test/audio.mp3';

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValueOnce({
        size: 1024000,
        mtime: new Date('2024-01-01T00:00:00Z')
      } as any);

      const hash1 = await transcriber.calculateFileHash(testPath);

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValueOnce({
        size: 1024000,
        mtime: new Date('2024-01-02T00:00:00Z')
      } as any);

      const hash2 = await transcriber.calculateFileHash(testPath);

      expect(hash1).not.toBe(hash2);
    });

    it('should include filename in hash calculation', async () => {
      const mockStats = {
        size: 1024000,
        mtime: new Date('2024-01-01T00:00:00Z')
      };

      (fs.statSync as jest.MockedFunction<typeof fs.statSync>).mockReturnValue(mockStats as any);

      const hash1 = await transcriber.calculateFileHash('/test/audio1.mp3');
      const hash2 = await transcriber.calculateFileHash('/test/audio2.mp3');

      expect(hash1).not.toBe(hash2);
    });
  });
});