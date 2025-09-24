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

  describe('buildContextualPrompt', () => {
    it('should build basic prompt without context', () => {
      const context = {
        previousTranscript: '',
        speakers: new Map(),
        speakerDescriptions: new Map()
      };

      const result = transcriber.buildContextualPrompt(context);

      expect(result).toContain('Please transcribe this audio segment');
      expect(result).toContain('Identify and label speakers consistently');
      expect(result).not.toContain('CONTEXT FROM PREVIOUS SEGMENT');
      expect(result).not.toContain('IDENTIFIED SPEAKERS SO FAR');
    });

    it('should include previous transcript when available', () => {
      const context = {
        previousTranscript: 'Previous conversation content here',
        speakers: new Map(),
        speakerDescriptions: new Map()
      };

      const result = transcriber.buildContextualPrompt(context);

      expect(result).toContain('CONTEXT FROM PREVIOUS SEGMENT');
      expect(result).toContain('Previous conversation content here');
    });

    it('should include identified speakers', () => {
      const speakers = new Map([
        ['1', 'Host'],
        ['2', 'Guest']
      ]);
      const context = {
        previousTranscript: '',
        speakers,
        speakerDescriptions: new Map()
      };

      const result = transcriber.buildContextualPrompt(context);

      expect(result).toContain('IDENTIFIED SPEAKERS SO FAR');
      expect(result).toContain('Host');
      expect(result).toContain('Guest');
      expect(result).toContain('Please use these same speaker labels for consistency');
    });

    it('should include speaker descriptions when available', () => {
      const speakers = new Map([['1', 'Host']]);
      const speakerDescriptions = new Map([['1', 'Main interviewer']]);
      const context = {
        previousTranscript: '',
        speakers,
        speakerDescriptions
      };

      const result = transcriber.buildContextualPrompt(context);

      expect(result).toContain('Host: Main interviewer');
    });

    it('should combine all context elements', () => {
      const speakers = new Map([
        ['1', 'Host'],
        ['2', 'Guest']
      ]);
      const speakerDescriptions = new Map([
        ['1', 'Main interviewer'],
        ['2', 'Expert on AI']
      ]);
      const context = {
        previousTranscript: 'Previous conversation about AI',
        speakers,
        speakerDescriptions
      };

      const result = transcriber.buildContextualPrompt(context);

      expect(result).toContain('CONTEXT FROM PREVIOUS SEGMENT');
      expect(result).toContain('Previous conversation about AI');
      expect(result).toContain('IDENTIFIED SPEAKERS SO FAR');
      expect(result).toContain('Host: Main interviewer');
      expect(result).toContain('Guest: Expert on AI');
      expect(result).toContain('Transcribe the audio now:');
    });
  });

  describe('updateContext', () => {
    it('should extract last 500 words from transcript', () => {
      const longText = Array(600).fill('word').join(' ');
      const transcript = {
        chunkIndex: 0,
        transcript: longText,
        speakers: new Set<string>(),
        mainContent: '',
        overlapContent: ''
      };
      const context = {
        previousTranscript: '',
        speakers: new Map(),
        speakerDescriptions: new Map()
      };

      const result = transcriber.updateContext(context, transcript);

      const wordCount = result.previousTranscript.split(/\s+/).length;
      expect(wordCount).toBe(500);
    });

    it('should use full transcript if less than 500 words', () => {
      const shortText = 'This is a short transcript with few words';
      const transcript = {
        chunkIndex: 0,
        transcript: shortText,
        speakers: new Set<string>(),
        mainContent: '',
        overlapContent: ''
      };
      const context = {
        previousTranscript: '',
        speakers: new Map(),
        speakerDescriptions: new Map()
      };

      const result = transcriber.updateContext(context, transcript);

      expect(result.previousTranscript).toBe(shortText);
    });

    it('should add new speakers to the context', () => {
      const transcript = {
        chunkIndex: 0,
        transcript: 'test',
        speakers: new Set(['Host', 'Guest']),
        mainContent: '',
        overlapContent: ''
      };
      const context = {
        previousTranscript: '',
        speakers: new Map(),
        speakerDescriptions: new Map()
      };

      const result = transcriber.updateContext(context, transcript);

      expect(result.speakers.has('Host')).toBe(true);
      expect(result.speakers.has('Guest')).toBe(true);
      expect(result.speakers.get('Host')).toBe('Host');
      expect(result.speakers.get('Guest')).toBe('Guest');
    });

    it('should preserve existing speakers', () => {
      const transcript = {
        chunkIndex: 0,
        transcript: 'test',
        speakers: new Set(['Guest2']),
        mainContent: '',
        overlapContent: ''
      };
      const context = {
        previousTranscript: '',
        speakers: new Map([['Host', 'Host'], ['Guest1', 'Guest1']]),
        speakerDescriptions: new Map()
      };

      const result = transcriber.updateContext(context, transcript);

      expect(result.speakers.size).toBe(3);
      expect(result.speakers.has('Host')).toBe(true);
      expect(result.speakers.has('Guest1')).toBe(true);
      expect(result.speakers.has('Guest2')).toBe(true);
    });

    it('should preserve speaker descriptions', () => {
      const transcript = {
        chunkIndex: 0,
        transcript: 'test',
        speakers: new Set<string>(),
        mainContent: '',
        overlapContent: ''
      };
      const speakerDescriptions = new Map([['Host', 'Main interviewer']]);
      const context = {
        previousTranscript: '',
        speakers: new Map(),
        speakerDescriptions
      };

      const result = transcriber.updateContext(context, transcript);

      expect(result.speakerDescriptions).toBe(speakerDescriptions);
    });
  });

  describe('mergeOverlaps', () => {
    beforeEach(() => {
      // Mock ora for these tests
      jest.clearAllMocks();
    });

    it('should use full transcript for first chunk', async () => {
      const transcripts = [
        {
          chunkIndex: 0,
          transcript: 'First chunk content',
          speakers: new Set<string>(),
          mainContent: 'First chunk main',
          overlapContent: 'First chunk overlap'
        }
      ];

      const result = await transcriber.mergeOverlaps(transcripts);

      expect(result).toBe('First chunk content');
    });

    it('should use mainContent for subsequent chunks', async () => {
      const transcripts = [
        {
          chunkIndex: 0,
          transcript: 'First chunk content',
          speakers: new Set<string>(),
          mainContent: 'First chunk main',
          overlapContent: 'First chunk overlap'
        },
        {
          chunkIndex: 1,
          transcript: 'Second chunk content with overlap',
          speakers: new Set<string>(),
          mainContent: 'Second chunk main only',
          overlapContent: 'Second chunk overlap'
        }
      ];

      const result = await transcriber.mergeOverlaps(transcripts);

      expect(result).toContain('First chunk content');
      expect(result).toContain('Second chunk main only');
      expect(result).not.toContain('Second chunk content with overlap');
    });

    it('should join chunks with separator', async () => {
      const transcripts = [
        {
          chunkIndex: 0,
          transcript: 'First',
          speakers: new Set<string>(),
          mainContent: 'First',
          overlapContent: ''
        },
        {
          chunkIndex: 1,
          transcript: 'Second',
          speakers: new Set<string>(),
          mainContent: 'Second',
          overlapContent: ''
        }
      ];

      const result = await transcriber.mergeOverlaps(transcripts);

      expect(result).toBe('First\n\n---\n\nSecond');
    });

    it('should handle empty transcripts array', async () => {
      const transcripts: any[] = [];

      const result = await transcriber.mergeOverlaps(transcripts);

      expect(result).toBe('');
    });

    it('should handle multiple chunks correctly', async () => {
      const transcripts = [
        {
          chunkIndex: 0,
          transcript: 'Chunk 1 full',
          speakers: new Set<string>(),
          mainContent: 'Chunk 1 main',
          overlapContent: 'overlap1'
        },
        {
          chunkIndex: 1,
          transcript: 'Chunk 2 full',
          speakers: new Set<string>(),
          mainContent: 'Chunk 2 main',
          overlapContent: 'overlap2'
        },
        {
          chunkIndex: 2,
          transcript: 'Chunk 3 full',
          speakers: new Set<string>(),
          mainContent: 'Chunk 3 main',
          overlapContent: 'overlap3'
        }
      ];

      const result = await transcriber.mergeOverlaps(transcripts);
      const parts = result.split('\n\n---\n\n');

      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('Chunk 1 full');
      expect(parts[1]).toBe('Chunk 2 main');
      expect(parts[2]).toBe('Chunk 3 main');
    });
  });
});