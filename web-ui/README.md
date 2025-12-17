# AI Builder Web UI

Web interface for the AI App Builder. Upload a Miro screenshot with your app requirements and watch it generate a complete Next.js app.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   # Copy .env.local.example to .env.local
   cp .env.local.example .env.local
   
   # Or copy the OPENAI_API_KEY from the parent directory's .env file
   # Edit .env.local and add your OPENAI_API_KEY
   ```

3. **Run the web UI:**
   ```bash
   npm run dev
   ```

   The web UI will run on http://localhost:3001

## Usage

1. Open http://localhost:3001 in your browser
2. Upload a screenshot (drag & drop or click to select)
3. The system will:
   - Extract text from the image using OpenAI Vision API
   - Generate a Next.js app based on the requirements
   - Build and start the app on http://localhost:3000
   - Automatically open the generated app in a new tab

## Architecture

- **Frontend**: Next.js 14 App Router with React
- **Backend API Routes**:
  - `/api/extract-text` - Extracts text from uploaded images using OpenAI Vision
  - `/api/generate-app` - Generates the Next.js app files
  - `/api/build-app` - Runs npm install and starts the dev server

## Notes

- The generated app will be in `../generated-app/` (parent directory)
- Port 3000 is reserved for the generated app
- Port 3001 is used for the web UI
- Make sure you have Node.js 18+ installed

