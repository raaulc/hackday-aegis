# Local AI Builder

A minimal local Replit-lite that generates and runs Next.js apps from natural language prompts or Miro screenshots.

## Features

- 🖼️ **Image Upload**: Upload Miro screenshots with app requirements
- 📝 **OCR Extraction**: Automatically extracts text and requirements from images
- 🤖 **AI Generation**: Uses OpenAI to generate complete Next.js apps
- 🚀 **Auto-run**: Automatically builds and starts your app

## Architecture

```
Image Upload (Web UI)
 ↓
OCR Text Extraction (OpenAI Vision)
 ↓
OpenAI (returns files as JSON)
 ↓
Local Runner (Node script)
 ↓
Filesystem (writes files)
 ↓
npm install
 ↓
npm run dev
 ↓
http://localhost:3000
```

## Stack Lock (Non-Negotiable)

- Node.js 18+
- Next.js 14.2.x (App Router)
- TypeScript
- Tailwind CSS
- Port 3000 (generated app)
- Port 3001 (web UI)
- No databases, Docker, Python, or Bun

## Setup

1. **Install root dependencies:**
   ```bash
   npm install
   ```

2. **Set up OpenAI API key:**
   ```bash
   # Create .env file in root directory
   echo "OPENAI_API_KEY=your_key_here" > .env
   ```

3. **Install and run the web UI:**
   ```bash
   npm run web-ui
   ```

   Or manually:
   ```bash
   cd web-ui
   npm install
   # Copy .env from parent or create .env.local with OPENAI_API_KEY
   npm run dev
   ```

4. **Open http://localhost:3001** in your browser

## Usage

### Web UI (Recommended)

1. Open http://localhost:3001
2. Upload a Miro screenshot with your app requirements
3. Watch as it:
   - Extracts text from the image
   - Generates the Next.js app
   - Builds and starts it on http://localhost:3000

### CLI (Original)

```bash
npm start "Build me a todo app"
```

Examples:
- `npm start "Build me a todo app"`
- `npm start "Create a simple calculator"`
- `npm start "Make a weather dashboard"`

## How It Works

1. **Image Upload**: User uploads a screenshot (Miro, design mockup, etc.)
2. **OCR**: OpenAI Vision API extracts all text and requirements
3. **Code Generation**: OpenAI generates a complete Next.js project as JSON
4. **File Writing**: All files are written to `generated-app/`
5. **Build & Run**: Runs `npm install && npm run dev`
6. **Auto-open**: Automatically opens http://localhost:3000

## Error Handling

If the app crashes:
- Error is captured
- Sent back to OpenAI with context
- OpenAI generates fixes
- Files are updated
- App restarts

## Project Structure

```
local-ai-builder/
 ├── lib/
 │   └── app-builder.ts      # Core app generation logic
 ├── web-ui/                  # Next.js web interface
 │   ├── app/
 │   │   ├── api/            # API routes (extract-text, generate-app, build-app)
 │   │   ├── components/     # React components
 │   │   └── page.tsx        # Main upload page
 │   └── lib/
 │       └── app-builder.ts  # AppBuilder class for web UI
 ├── generated-app/          # Generated apps (created automatically)
 ├── runner.ts               # CLI runner script
 ├── system-prompt.txt       # Locked system prompt for OpenAI
 └── .env                    # OpenAI API key
```

## Requirements

- Node.js 18+
- npm
- OpenAI API key (with access to GPT-4 Vision and GPT-4 Turbo)

## Notes

- No Docker needed for local use
- No GitHub integration
- No CI/CD
- Minimal moving parts - just OpenAI, file writing, and npm
- Port 3000: Generated app
- Port 3001: Web UI

The mental model: **"I uploaded a screenshot and an app appeared."**
