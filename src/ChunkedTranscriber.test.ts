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

  describe('formatTime', () => {
    it('should format single digit seconds correctly', () => {
      const result = transcriber.formatTime(5);
      expect(result).toBe('0:05');
    });

    it('should format double digit seconds correctly', () => {
      const result = transcriber.formatTime(42);
      expect(result).toBe('0:42');
    });

    it('should format single minutes correctly', () => {
      const result = transcriber.formatTime(60);
      expect(result).toBe('1:00');
    });

    it('should format minutes and seconds correctly', () => {
      const result = transcriber.formatTime(125);
      expect(result).toBe('2:05');
    });

    it('should format large times correctly', () => {
      const result = transcriber.formatTime(3665);
      expect(result).toBe('61:05');
    });

    it('should handle decimal seconds by flooring', () => {
      const result = transcriber.formatTime(65.9);
      expect(result).toBe('1:05');
    });

    it('should handle zero correctly', () => {
      const result = transcriber.formatTime(0);
      expect(result).toBe('0:00');
    });

    it('should handle exactly 10 minutes', () => {
      const result = transcriber.formatTime(600);
      expect(result).toBe('10:00');
    });
  });

  describe('cache management', () => {
    describe('setupCacheDir', () => {
      it('should create cache directory if it does not exist', async () => {
        const fileHash = 'test-hash';
        (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(false);
        (fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>).mockImplementation(() => undefined);

        const result = await transcriber.setupCacheDir(fileHash);

        expect(fs.mkdirSync).toHaveBeenCalledWith(
          expect.stringContaining(fileHash),
          { recursive: true }
        );
        expect(result).toContain(fileHash);
      });

      it('should not create directory if it already exists', async () => {
        const fileHash = 'test-hash';
        (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);

        const result = await transcriber.setupCacheDir(fileHash);

        expect(fs.mkdirSync).not.toHaveBeenCalled();
        expect(result).toContain(fileHash);
      });
    });

    describe('isCacheValid', () => {
      it('should return true if metadata file exists', async () => {
        const fileHash = 'test-hash';
        (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(true);

        const result = await transcriber.isCacheValid(fileHash);

        expect(fs.existsSync).toHaveBeenCalledWith(
          expect.stringContaining('metadata.json')
        );
        expect(result).toBe(true);
      });

      it('should return false if metadata file does not exist', async () => {
        const fileHash = 'test-hash';
        (fs.existsSync as jest.MockedFunction<typeof fs.existsSync>).mockReturnValue(false);

        const result = await transcriber.isCacheValid(fileHash);

        expect(result).toBe(false);
      });
    });

    describe('loadCacheMetadata', () => {
      it('should load and parse metadata from file', async () => {
        const fileHash = 'test-hash';
        const mockMetadata = {
          sourceFile: 'test.mp3',
          fileHash: fileHash,
          duration: 600,
          chunkDuration: 600,
          overlapDuration: 30,
          chunks: [],
          createdAt: '2024-01-01T00:00:00Z',
          transcripts: {}
        };

        (fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>).mockReturnValue(
          JSON.stringify(mockMetadata)
        );

        const result = await transcriber.loadCacheMetadata(fileHash);

        expect(fs.readFileSync).toHaveBeenCalledWith(
          expect.stringContaining('metadata.json'),
          'utf-8'
        );
        expect(result).toEqual(mockMetadata);
      });
    });

    describe('saveCacheMetadata', () => {
      it('should save metadata to file as JSON', async () => {
        const fileHash = 'test-hash';
        const mockMetadata = {
          sourceFile: 'test.mp3',
          fileHash: fileHash,
          duration: 600,
          chunkDuration: 600,
          overlapDuration: 30,
          chunks: [],
          createdAt: '2024-01-01T00:00:00Z',
          transcripts: {}
        } as any;

        await transcriber.saveCacheMetadata(fileHash, mockMetadata);

        expect(fs.writeFileSync).toHaveBeenCalledWith(
          expect.stringContaining('metadata.json'),
          JSON.stringify(mockMetadata, null, 2)
        );
      });
    });
  });
});