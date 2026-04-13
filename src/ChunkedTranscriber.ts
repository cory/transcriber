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
  private model: string = "gemini-3.1-pro-preview";
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
    let prompt = `You are transcribing a rare historical recording for archival purposes. Accuracy is critical — this may be the only record of what was said.

Requirements:
1. Identify and label speakers consistently
2. Format each speaker's dialogue on a new line with "**Speaker Name:**" format
3. Clean up filler words but maintain natural speech patterns
4. Preserve the meaning and flow of conversation
5. Reproduce all language exactly as spoken, including profanity, slang, and coarse or offensive language — do not censor, soften, or sanitize. Scholarly accuracy demands faithful reproduction.
6. When uncertain about a word, prefer the more specific or colorful interpretation over a generic one — the speaker is blunt and colloquial.

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

    // Update speaker list — re-extract from transcript text since Set doesn't survive JSON round-trip
    const updatedSpeakers = new Map(context.speakers);
    const speakerMatches = transcript.transcript.matchAll(/\*\*(.*?):\*\*/g);
    const speakers = new Set<string>();
    for (const match of speakerMatches) {
      speakers.add(match[1]);
    }
    for (const speaker of speakers) {
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
   * Seam cache — separate file from metadata.json to avoid corruption risk
   */
  private seamCachePath(fileHash: string): string {
    return path.join(this.cacheDir, fileHash, "seam-cache.json");
  }

  private loadSeamCache(fileHash: string): { [key: number]: string } {
    const cachePath = this.seamCachePath(fileHash);
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
    return {};
  }

  private saveSeamCache(fileHash: string, cache: { [key: number]: string }): void {
    fs.writeFileSync(this.seamCachePath(fileHash), JSON.stringify(cache, null, 2));
  }

  /**
   * Merge and deduplicate seams between chunks using targeted LLM calls.
   * For each boundary, sends the full previous chunk and full next chunk,
   * asks Gemini to merge them into one continuous passage with overlap removed.
   * Then stitches the final transcript by taking each chunk's unique interior
   * and the merged seam regions.
   */
  public async mergeAndPolish(transcripts: ChunkTranscript[], fileHash: string): Promise<string> {
    if (transcripts.length === 0) return '';
    if (transcripts.length === 1) return transcripts[0].transcript;

    const seamCache = this.loadSeamCache(fileHash);
    const cachedCount = Object.keys(seamCache).length;
    const totalSeams = transcripts.length - 1;

    const spinner = ora(`Merging seams (${cachedCount}/${totalSeams})...`).start();

    for (let i = 0; i < totalSeams; i++) {
      if (seamCache[i] !== undefined) {
        continue;
      }

      spinner.text = `Merging seam ${i + 1}/${totalSeams}...`;

      const prevFull = transcripts[i].transcript;
      const nextFull = transcripts[i + 1].transcript;

      const prompt = `These are two consecutive segments from the same audio transcription. The segments overlap by about 30 seconds, so there is duplicated content where the first segment ends and the second begins.

Your job: produce one continuous merged transcript from these two segments. Remove the duplicated content at the boundary. Keep ALL unique content from both segments. Return ONLY the merged transcript text, no commentary or notes.

SEGMENT ${i + 1}:
${prevFull}

SEGMENT ${i + 2}:
${nextFull}

Return the single merged transcript:`;

      try {
        const result = await this.genAI.models.generateContent({
          model: this.model,
          contents: [{
            role: "user",
            parts: [{ text: prompt }]
          }]
        });

        seamCache[i] = result.text || `${prevFull}\n\n${nextFull}`;
      } catch (error) {
        spinner.warn(`Seam ${i + 1}/${totalSeams} failed, using raw concatenation`);
        seamCache[i] = `${prevFull}\n\n${nextFull}`;
      }

      this.saveSeamCache(fileHash, seamCache);
    }

    spinner.succeed(`All ${totalSeams} seams merged`);

    // Stitch final transcript from the pairwise merges.
    // Each seamCache[i] is the merge of chunks i and i+1.
    // We take: chunk 0 start ... seam 0 handles the boundary ... seam 1 handles next boundary ... etc.
    // Strategy: use seam results to extract the merged boundary region.
    // Simpler approach: chain the seam merges. seam[0] = merge(chunk0, chunk1).
    // seam[1] = merge(chunk1, chunk2). We need chunk0-unique + boundary0 + chunk1-unique-middle + boundary1 + ...
    //
    // Easiest correct approach: take seam[0] as the base (it has chunks 0+1 merged),
    // then for each subsequent seam, we know it starts with chunk[i] content which
    // overlaps with the end of the previous seam. We can use the same dedup logic.
    //
    // But that grows the payload again. Instead, let's just concatenate chunks
    // with seam results replacing the boundary regions.
    //
    // Simplest: for N chunks, we have N-1 pairwise merges. The final transcript
    // is assembled by taking unique-start from seam[0], then for each subsequent
    // seam, appending content that's new (not in the previous seam).
    //
    // Actually the simplest correct thing: just output seam merges and accept
    // minor redundancy in chunk interiors, OR do the final stitch locally
    // without an LLM call.
    //
    // Let's do it deterministically: each seam[i] is merge(chunk_i, chunk_{i+1}).
    // The final transcript is:
    //   - From seam[0]: everything up to where chunk[1] unique content starts
    //   - From seam[1]: the chunk[1]+chunk[2] merge, minus the chunk[1] part (which we already have)
    //   etc.
    //
    // This is hard to do perfectly without another LLM call. The pragmatic approach:
    // just use the pairwise merges directly. Take seam[0], then for each subsequent
    // chunk, take only the NEW content from seam[i] that wasn't in chunk[i].

    // Pragmatic approach: use first seam as base, then append the tail of each
    // subsequent seam (the part after the shared chunk content).
    const spinner2 = ora('Stitching final transcript...').start();

    // Start with the first pairwise merge (chunks 0+1)
    let result = seamCache[0];

    for (let i = 1; i < totalSeams; i++) {
      // seamCache[i] = merge of chunk[i] and chunk[i+1]
      // We already have chunk[i] content in our result.
      // We need to find where chunk[i+1]'s unique content starts in seamCache[i]
      // and append just that.

      // Use chunk[i+1]'s first substantial line as an anchor to find where
      // the new content begins in the seam merge.
      const nextChunkLines = transcripts[i + 1].transcript.split('\n').filter(l => l.trim());
      // Skip first few lines (likely overlap) and find a unique anchor deeper in
      const anchorSearchStart = Math.min(5, Math.floor(nextChunkLines.length * 0.3));
      let appendFrom = -1;

      for (let j = anchorSearchStart; j < nextChunkLines.length; j++) {
        const anchor = nextChunkLines[j].trim();
        if (anchor.length < 20) continue; // skip short lines
        const pos = seamCache[i].lastIndexOf(anchor);
        if (pos !== -1) {
          // Found the anchor in the seam merge — take everything after it
          appendFrom = pos + anchor.length;
          break;
        }
      }

      if (appendFrom !== -1) {
        const newContent = seamCache[i].substring(appendFrom).trim();
        if (newContent) {
          result += '\n\n' + newContent;
        }
      } else {
        // Couldn't find anchor — just append chunk[i+1] transcript directly
        result += '\n\n' + transcripts[i + 1].transcript;
      }
    }

    spinner2.succeed('Stitching complete');
    return result;
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

    // Merge seams and stitch
    console.log();
    const finalTranscript = await this.mergeAndPolish(transcripts, fileHash);

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