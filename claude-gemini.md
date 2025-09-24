# Google Gemini API - Correct Usage Guide

## NPM Package

The correct NPM package for using Google's Gemini API is:

```json
"@google/genai": "latest"
```

**Note:** Do NOT use `@google-ai/generativelanguage` or other packages - `@google/genai` is the official and idiomatic package.

## Installation

```bash
npm install @google/genai
```

## Basic Usage Pattern

```typescript
import { GoogleGenAI } from "@google/genai";

// Initialize with API key
const genAI = new GoogleGenAI({ apiKey: API_KEY });

// Generate content
const result = await genAI.models.generateContent({
  model: "gemini-2.5-pro", // or other model versions
  contents: [{
    role: "user",
    parts: [{ text: "Your prompt here" }]
  }]
});

const responseText = result.text || "";
```

## Multimodal Usage (Audio/Images)

For audio transcription or image analysis:

```typescript
const audioBuffer = fs.readFileSync(audioPath);
const audioBase64 = audioBuffer.toString('base64');

const result = await genAI.models.generateContent({
  model: "gemini-2.5-pro",
  contents: [{
    role: "user",
    parts: [
      { text: "Your prompt" },
      {
        inlineData: {
          mimeType: "audio/mp3", // or "image/png", "image/jpeg", etc.
          data: audioBase64
        }
      }
    ]
  }]
});
```

## Environment Variables

Use either of these environment variable names for the API key:
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

## Available Models

Common model options:
- `gemini-2.5-pro` - Latest and most capable
- `gemini-2.5-flash` - Faster, lighter model

## Documentation

For comprehensive API documentation in LLM-friendly format, reference:
https://ai.google.dev/gemini-api/docs/llms.txt

This URL provides structured documentation optimized for consumption by language models.

## Key Points

1. **Import Style**: Use `import { GoogleGenAI } from "@google/genai"` (named import)
2. **Initialization**: Create instance with `new GoogleGenAI({ apiKey })`
3. **Method Call**: Use `genAI.models.generateContent()` for all generation tasks
4. **Response Access**: Access text with `result.text` property
5. **Multimodal**: Supports audio, images, and text in the same API pattern
6. **Base64 Encoding**: Binary data (audio/images) must be base64 encoded

## TypeScript Support

The package includes TypeScript definitions. For proper typing:

```typescript
import { GoogleGenAI } from "@google/genai";
```

No need for separate `@types/` packages.
