# Gemini Audio Transcriber

A robust audio transcription tool using Google Gemini with intelligent chunking, caching, and context-aware processing. Handles files of any size with automatic resume on failure.

## Features

- 🎯 **Smart Chunking**: Automatically splits large audio files into 10-minute chunks with 30-second overlaps
- 💾 **Intelligent Caching**: Never re-process chunks you've already transcribed
- 🔄 **Resume on Failure**: Automatically picks up where it left off if interrupted
- 🎙️ **Speaker Diarization**: Identifies and labels different speakers consistently
- 📝 **Context-Aware**: Each chunk gets context from previous chunks for better accuracy
- ✨ **Final Polish**: Applies a final pass to standardize formatting and clean up boundaries

## Prerequisites

- Node.js 18+
- ffmpeg (for audio chunking)
  ```bash
  # macOS
  brew install ffmpeg

  # Ubuntu/Debian
  sudo apt-get install ffmpeg

  # Windows (via Chocolatey)
  choco install ffmpeg
  ```

## Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:cory/transcriber.git
   cd transcriber
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your Google Gemini API key:
   ```bash
   cp .env.example .env
   # Edit .env and add your GEMINI_API_KEY or GOOGLE_API_KEY
   ```

4. Build the project:
   ```bash
   npm run build
   ```

## Usage

### Basic Usage

```bash
npm start audio.mp3
```

Or directly:
```bash
node dist/index.js audio.mp3
```

### Options

```bash
# Specify output file
npm start audio.mp3 -- -o transcript.md

# Use a different model
npm start audio.mp3 -- --model gemini-2.5-flash

# Custom cache directory
npm start audio.mp3 -- --cache-dir /path/to/cache
```

### Available Models

- `gemini-2.5-pro` (default) - Best accuracy, speaker identification
- `gemini-2.5-flash` - Faster, more cost-effective
- `gemini-1.5-pro` - Previous generation, still reliable

## How It Works

1. **File Analysis**: Checks file duration and calculates required chunks
2. **Smart Caching**:
   - Creates a unique hash for your file
   - Stores chunks in `.cache/audio/[hash]/`
   - Saves transcripts after each chunk
3. **Progressive Transcription**:
   - Each chunk includes context from the previous chunk
   - Maintains consistent speaker labels across chunks
   - Shows real-time progress
4. **Overlap Resolution**:
   - 30-second overlaps ensure no content is lost
   - Intelligent deduplication at chunk boundaries
5. **Final Polish**:
   - Standardizes all speaker labels
   - Adds section breaks where appropriate
   - Cleans up any artifacts from chunking

## Cache Structure

```
.cache/audio/
└── [file-hash]/
    ├── metadata.json      # Contains all transcripts and progress
    ├── chunk-001.mp3      # 0:00 - 10:00
    ├── chunk-002.mp3      # 9:30 - 19:30
    ├── chunk-003.mp3      # 19:00 - 29:00
    └── ...
```

The cache is kept indefinitely, allowing you to:
- Resume failed transcriptions
- Re-run with different settings without re-chunking
- Manually inspect individual chunks if needed

## Output Format

The tool generates clean markdown with:
- Speaker labels (e.g., **Speaker 1:**, **Host:**, **Guest:**)
- Section breaks between topics
- Metadata (date, source file, model used)
- Full formatted transcript

## Troubleshooting

### "ffmpeg: command not found"
Install ffmpeg using the instructions in Prerequisites.

### "API quota exceeded"
Check your Google Cloud Console for quota limits. Consider using `gemini-2.5-flash` for lower cost.

### Transcription seems stuck
Check the `.cache/audio/[hash]/metadata.json` file to see progress. The tool saves after each chunk.

### Want to restart fresh?
Delete the cache directory for your file:
```bash
rm -rf .cache/audio/[hash]/
```

## Testing

The project includes comprehensive unit tests for all core functionality:

```bash
# Run all tests
npm test

# Run tests in watch mode for development
npm test:watch

# Run tests with coverage report
npm test:coverage

# Run specific test suites
NODE_OPTIONS="--experimental-vm-modules" npm test -- ChunkedTranscriber.test.ts
```

### Test Coverage

The test suite covers:
- **File hashing**: Consistent hash generation for cache identification
- **Time formatting**: Edge cases and various time formats
- **Cache management**: Directory creation, metadata serialization/deserialization
- **Context building**: Prompt generation with speaker tracking
- **Chunk processing**: Overlap resolution and merging strategies
- **Error handling**: FFmpeg failures, invalid JSON, missing files

Tests are written using Jest with ESM support and include extensive mocking to avoid external dependencies.

## Performance

- **File Size**: No limit (tested with 2+ hour podcasts)
- **Processing Time**: ~1-2 minutes per 10-minute chunk
- **Memory Usage**: Low, processes one chunk at a time
- **Network**: Uploads ~20MB per chunk

## License

MIT