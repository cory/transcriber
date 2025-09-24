#!/usr/bin/env node

import * as path from "path";
import dotenv from "dotenv";
import chalk from "chalk";
import { Command } from "commander";
import { ChunkedTranscriber } from "./ChunkedTranscriber.js";

dotenv.config();

// Get the API key from environment variables
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error(chalk.red("Error: GEMINI_API_KEY is not set in the .env file"));
  process.exit(1);
}

// CLI
const program = new Command();

program
  .name('gemini-chunked')
  .description('Transcribe large audio files with intelligent chunking and caching')
  .version('3.0.0');

program
  .argument('<input>', 'Path to the audio file')
  .option('-o, --output <path>', 'Output file path')
  .option('-m, --model <model>', 'Gemini model to use', 'gemini-2.5-pro')
  .option('--cache-dir <dir>', 'Cache directory', '.cache/audio')
  .action(async (input: string, options) => {
    try {
      const inputPath = path.resolve(input);
      const outputPath = options.output ||
        `${path.basename(inputPath, path.extname(inputPath))}-transcript.md`;

      const transcriber = new ChunkedTranscriber({
        apiKey: API_KEY,
        cacheDir: options.cacheDir,
        model: options.model
      });

      await transcriber.transcribe(inputPath, outputPath);
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), error);
      process.exit(1);
    }
  });

program.parse();