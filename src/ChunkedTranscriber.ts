import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import ora from "ora";
import chalk from "chalk";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface ChunkInfo {
  index: number;
  filename: string;
  path: string;
  startTime: number;
  endTime: number;
  duration: number;
  hasOverlap: boolean;
}

export interface ChunkTranscript {
  chunkIndex: number;
  transcript: string;
  speakers: Set<string>;
  mainContent: string;
  overlapContent: string;
}

export interface TranscriptionContext {
  previousTranscript: string;
  speakers: Map<string, string>;
  speakerDescriptions: Map<string, string>;
}

export interface CacheMetadata {
  sourceFile: string;
  fileHash: string;
  duration: number;
  chunkDuration: number;
  overlapDuration: number;
  chunks: ChunkInfo[];
  createdAt: string;
  transcripts: { [key: number]: ChunkTranscript };
}

export class ChunkedTranscriber {
  private cacheDir: string = ".cache/audio";
  private chunkDuration: number = 600; // 10 minutes
  private overlapDuration: number = 30; // 30 seconds
  private model: string = "gemini-2.5-pro";
  private genAI: GoogleGenAI;

  constructor(options: { apiKey: string; cacheDir?: string; model?: string }) {
    if (options.cacheDir) this.cacheDir = options.cacheDir;
    if (options.model) this.model = options.model;
    this.genAI = new GoogleGenAI({ apiKey: options.apiKey });
  }

  /**
   * Calculate hash of file for cache identification
   */
  public async calculateFileHash(filePath: string): Promise<string> {
    const stats = fs.statSync(filePath);
    const hash = crypto.createHash('md5');
    hash.update(`${path.basename(filePath)}-${stats.size}-${stats.mtime.getTime()}`);
    return hash.digest('hex');
  }

  /**
   * Get audio duration using ffprobe
   */
  public async getAudioDuration(filePath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -print_format json -show_format "${filePath}"`
      );
      const data = JSON.parse(stdout);
      return parseFloat(data.format.duration);
    } catch (error) {
      throw new Error(`Failed to get audio duration: ${error}`);
    }
  }

  /**
   * Create cache directory structure
   */
  public async setupCacheDir(fileHash: string): Promise<string> {
    const cacheDir = path.join(this.cacheDir, fileHash);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  }

  /**
   * Check if valid cache exists
   */
  public async isCacheValid(fileHash: string): Promise<boolean> {
    const metadataPath = path.join(this.cacheDir, fileHash, "metadata.json");
    return fs.existsSync(metadataPath);
  }

  /**
   * Load cache metadata
   */
  public async loadCacheMetadata(fileHash: string): Promise<CacheMetadata> {
    const metadataPath = path.join(this.cacheDir, fileHash, "metadata.json");
    const data = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(data);
  }

  /**
   * Save cache metadata
   */
  public async saveCacheMetadata(fileHash: string, metadata: CacheMetadata): Promise<void> {
    const metadataPath = path.join(this.cacheDir, fileHash, "metadata.json");
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Create audio chunks with overlap
   */
  public async createChunks(audioPath: string, fileHash: string): Promise<ChunkInfo[]> {
    const spinner = ora('Creating audio chunks...').start();
    const cacheDir = await this.setupCacheDir(fileHash);
    const duration = await this.getAudioDuration(audioPath);
    const chunks: ChunkInfo[] = [];

    let currentTime = 0;
    let chunkIndex = 0;

    while (currentTime < duration) {
      const startTime = Math.max(0, currentTime - (chunkIndex > 0 ? this.overlapDuration : 0));
      const endTime = Math.min(duration, currentTime + this.chunkDuration);

      const chunkFilename = `chunk-${String(chunkIndex + 1).padStart(3, '0')}.mp3`;
      const chunkPath = path.join(cacheDir, chunkFilename);

      // Create chunk using ffmpeg
      const ffmpegCommand = `ffmpeg -i "${audioPath}" -ss ${startTime} -t ${endTime - startTime} -acodec mp3 -y "${chunkPath}"`;

      spinner.text = `Creating chunk ${chunkIndex + 1} (${this.formatTime(startTime)} - ${this.formatTime(endTime)})`;

      await execAsync(ffmpegCommand);

      chunks.push({
        index: chunkIndex,
        filename: chunkFilename,
        path: chunkPath,
        startTime,
        endTime,
        duration: endTime - startTime,
        hasOverlap: chunkIndex > 0
      });

      currentTime += this.chunkDuration;
      chunkIndex++;
    }

    spinner.succeed(`Created ${chunks.length} chunks`);
    return chunks;
  }

  /**
   * Format time in MM:SS
   */
  public formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Build contextual prompt for chunk transcription
   */
  public buildContextualPrompt(context: TranscriptionContext): string {
    let prompt = `Please transcribe this audio segment with the following requirements:

1. Identify and label speakers consistently
2. Format each speaker's dialogue on a new line with "**Speaker Name:**" format
3. Clean up filler words but maintain natural speech patterns
4. Preserve the meaning and flow of conversation

`;

    if (context.previousTranscript) {
      prompt += `\nCONTEXT FROM PREVIOUS SEGMENT:\n${context.previousTranscript}\n\n`;
    }

    if (context.speakers.size > 0) {
      prompt += `IDENTIFIED SPEAKERS SO FAR:\n`;
      for (const [id, name] of context.speakers.entries()) {
        const desc = context.speakerDescriptions.get(id);
        prompt += `- ${name}${desc ? `: ${desc}` : ''}\n`;
      }
      prompt += `\nPlease use these same speaker labels for consistency.\n\n`;
    }

    prompt += `Transcribe the audio now:`;

    return prompt;
  }

  /**
   * Transcribe a single chunk
   */
  public async transcribeChunk(
    chunk: ChunkInfo,
    context: TranscriptionContext
  ): Promise<ChunkTranscript> {
    const audioBuffer = fs.readFileSync(chunk.path);
    const audioBase64 = audioBuffer.toString('base64');

    const prompt = this.buildContextualPrompt(context);

    const result = await this.genAI.models.generateContent({
      model: this.model,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "audio/mp3",
              data: audioBase64
            }
          }
        ]
      }]
    });

    const transcript = result.text || "";

    // Extract speakers from transcript
    const speakers = new Set<string>();
    const speakerMatches = transcript.matchAll(/\*\*(.*?):\*\*/g);
    for (const match of speakerMatches) {
      speakers.add(match[1]);
    }

    // Split content for overlap handling
    const lines = transcript.split('\n');
    const totalLines = lines.length;
    const overlapLines = chunk.hasOverlap ? Math.ceil(totalLines * 0.1) : 0;

    const mainContent = lines.slice(0, -overlapLines || undefined).join('\n');
    const overlapContent = overlapLines > 0 ? lines.slice(-overlapLines).join('\n') : '';

    return {
      chunkIndex: chunk.index,
      transcript,
      speakers,
      mainContent,
      overlapContent
    };
  }

  /**
   * Update context for next chunk
   */
  public updateContext(
    context: TranscriptionContext,
    transcript: ChunkTranscript
  ): TranscriptionContext {
    // Extract last ~500 words for context
    const words = transcript.transcript.split(/\s+/);
    const contextWords = words.slice(-500).join(' ');

    // Update speaker list
    const updatedSpeakers = new Map(context.speakers);
    for (const speaker of transcript.speakers) {
      if (!updatedSpeakers.has(speaker)) {
        updatedSpeakers.set(speaker, speaker);
      }
    }

    return {
      previousTranscript: contextWords,
      speakers: updatedSpeakers,
      speakerDescriptions: context.speakerDescriptions
    };
  }

  /**
   * Merge overlapping sections
   */
  public async mergeOverlaps(transcripts: ChunkTranscript[]): Promise<string> {
    const spinner = ora('Resolving overlaps...').start();
    const merged: string[] = [];

    for (let i = 0; i < transcripts.length; i++) {
      if (i === 0) {
        // First chunk - use everything
        merged.push(transcripts[i].transcript);
      } else {
        // For subsequent chunks, remove overlap that was already included
        merged.push(transcripts[i].mainContent);
      }
    }

    spinner.succeed('Overlaps resolved');
    return merged.join('\n\n---\n\n');
  }

  /**
   * Final polish pass
   */
  public async polishTranscript(rawTranscript: string): Promise<string> {
    const spinner = ora('Applying final polish...').start();

    const prompt = `Please review and polish this transcript:

1. Standardize all speaker labels (ensure consistent naming throughout)
2. Add section breaks (---) between major topic changes
3. Fix any obvious transcription errors
4. Ensure consistent formatting
5. Clean up any duplicate content from chunk boundaries

Important: Preserve all actual content, only fix formatting and consistency issues.

TRANSCRIPT:
${rawTranscript}

Return the polished transcript:`;

    const result = await this.genAI.models.generateContent({
      model: this.model,
      contents: [{
        role: "user",
        parts: [{ text: prompt }]
      }]
    });

    spinner.succeed('Polish complete');
    return result.text || rawTranscript;
  }

  /**
   * Format transcript as markdown
   */
  public formatAsMarkdown(transcript: string, audioPath: string): string {
    const fileName = path.basename(audioPath, path.extname(audioPath));
    const timestamp = new Date().toISOString().split('T')[0];

    let markdown = `# Transcript: ${fileName}\n\n`;
    markdown += `**Date:** ${timestamp}\n`;
    markdown += `**Source:** ${path.basename(audioPath)}\n`;
    markdown += `**Model:** ${this.model}\n\n`;
    markdown += `---\n\n`;
    markdown += transcript;
    markdown += `\n\n---\n\n`;
    markdown += `*Transcribed using Google Gemini with intelligent chunking*\n`;

    return markdown;
  }

  /**
   * Main transcription orchestrator
   */
  async transcribe(audioPath: string, outputPath: string): Promise<void> {
    console.log(chalk.cyan('\n🎙️  Gemini Chunked Transcriber\n'));

    // Check file exists
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const stats = fs.statSync(audioPath);
    console.log(chalk.cyan('📁 File Information:'));
    console.log(`  Path: ${audioPath}`);
    console.log(`  Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB\n`);

    // Calculate file hash
    const fileHash = await this.calculateFileHash(audioPath);
    let metadata: CacheMetadata;
    let chunks: ChunkInfo[];

    // Check for existing cache
    if (await this.isCacheValid(fileHash)) {
      console.log(chalk.green('✅ Found cached chunks\n'));
      metadata = await this.loadCacheMetadata(fileHash);
      chunks = metadata.chunks;
    } else {
      // Create new chunks
      const duration = await this.getAudioDuration(audioPath);
      chunks = await this.createChunks(audioPath, fileHash);

      metadata = {
        sourceFile: audioPath,
        fileHash,
        duration,
        chunkDuration: this.chunkDuration,
        overlapDuration: this.overlapDuration,
        chunks,
        createdAt: new Date().toISOString(),
        transcripts: {}
      };

      await this.saveCacheMetadata(fileHash, metadata);
    }

    console.log(chalk.cyan(`\n📊 Processing ${chunks.length} chunks with ${this.model}\n`));

    // Transcribe chunks with context
    const transcripts: ChunkTranscript[] = [];
    let context: TranscriptionContext = {
      previousTranscript: '',
      speakers: new Map(),
      speakerDescriptions: new Map()
    };

    for (const chunk of chunks) {
      // Check if we already have this transcript
      if (metadata.transcripts[chunk.index]) {
        console.log(chalk.gray(`Chunk ${chunk.index + 1}/${chunks.length}: Using cached transcript`));
        const cached = metadata.transcripts[chunk.index];
        transcripts.push(cached);
        context = this.updateContext(context, cached);
      } else {
        // Transcribe new chunk
        const spinner = ora(`Chunk ${chunk.index + 1}/${chunks.length}: Transcribing...`).start();

        try {
          const transcript = await this.transcribeChunk(chunk, context);
          transcripts.push(transcript);

          // Save progress
          metadata.transcripts[chunk.index] = transcript;
          await this.saveCacheMetadata(fileHash, metadata);

          // Update context for next chunk
          context = this.updateContext(context, transcript);

          spinner.succeed(`Chunk ${chunk.index + 1}/${chunks.length}: Complete (${transcript.speakers.size} speakers)`);
        } catch (error) {
          spinner.fail(`Chunk ${chunk.index + 1}/${chunks.length}: Failed`);
          throw error;
        }
      }
    }

    // Merge overlaps
    console.log();
    const mergedTranscript = await this.mergeOverlaps(transcripts);

    // Final polish
    const finalTranscript = await this.polishTranscript(mergedTranscript);

    // Format as markdown
    const markdown = this.formatAsMarkdown(finalTranscript, audioPath);

    // Save output
    fs.writeFileSync(outputPath, markdown);
    console.log(chalk.green(`\n✅ Transcript saved to: ${outputPath}\n`));

    // Stats
    const wordCount = finalTranscript.split(/\s+/).length;
    console.log(chalk.cyan('📊 Summary:'));
    console.log(`  Total chunks: ${chunks.length}`);
    console.log(`  Total words: ${wordCount}`);
    console.log(`  Cache location: ${path.join(this.cacheDir, fileHash)}\n`);
  }
}