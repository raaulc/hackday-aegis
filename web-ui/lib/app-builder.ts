import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'

export interface ProjectResponse {
  port: number
  files: Record<string, string>
}

export class AppBuilder {
  private openai: OpenAI
  private appDir: string
  private systemPromptPath: string

  constructor(apiKey: string, appDir?: string) {
    this.openai = new OpenAI({ apiKey })
    // appDir should be in the parent directory (hackday/generated-app)
    this.appDir = appDir || path.join(process.cwd(), '..', 'generated-app')
    this.systemPromptPath = path.join(process.cwd(), '..', 'system-prompt.txt')
  }

  async readSystemPrompt(): Promise<string> {
    try {
      return await fs.promises.readFile(this.systemPromptPath, 'utf-8')
    } catch (error) {
      throw new Error(`Failed to read system prompt: ${error}`)
    }
  }

  async generateApp(userPrompt: string, errorContext?: string): Promise<ProjectResponse> {
    const systemPrompt = await this.readSystemPrompt()
    
    // Enhance the user prompt to emphasize full implementation
    const enhancedPrompt = errorContext 
      ? `${userPrompt}\n\nError occurred:\n${errorContext}\n\nIMPORTANT: You must return ALL required files for a complete Next.js Pages Router app, including package.json, tsconfig.json, next.config.js, tailwind.config.js, postcss.config.js, pages/_app.tsx, pages/_document.tsx, pages/index.tsx, and styles/globals.css. Do not return partial files. Return the complete fixed project as a full JSON response with all files.`
      : `Build a fully functional Next.js application with the following requirements:\n\n${userPrompt}\n\nIMPORTANT: 
- Implement the COMPLETE functionality described above - make it ACTUALLY WORK
- DO NOT create placeholder pages, "coming soon" messages, or mock/fake implementations
- The app must be fully working and usable immediately - real functionality, not fake
- Use React hooks, state management, and event handlers as needed
- Make it functional and interactive if the requirements specify interactivity
- Style it properly with Tailwind CSS to make it look professional

CRITICAL UI/UX REQUIREMENTS:
- All buttons and interactive elements MUST be clearly visible in the UI with proper labels
- Follow standard user flow: User inputs/selects → User clicks button → Action executes → Result displayed
- DO NOT auto-trigger actions on file selection or input change (e.g., don't convert on file selection - show a button to click)
- For file uploads: Show file input → Show action button (e.g., "Convert", "Upload", "Process") → Button triggers action
- For forms: Show all inputs → Show submit button → Button triggers submission
- Show loading states when processing (disable button, show "Loading..." text/spinner)
- Show success/error messages and results clearly after actions complete
- Make the interface intuitive and self-explanatory

CRITICAL: If the functionality requires capabilities beyond browser APIs, add appropriate npm packages to make it work. Priority is WORKING functionality over avoiding packages.
- ONLY use npm packages that actually exist on npm AND are compatible with React 18
- When adding packages, use well-known, actively maintained libraries (e.g., mammoth for DOCX, pdf-lib for PDFs)
- Verify package names exist on npm before adding them
- DO NOT create fake conversions or mock functionality - implement real working solutions
- If browser APIs can't do it, use a library. If a library is needed, add it to package.json.`
    
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { 
        role: 'user', 
        content: enhancedPrompt
      }
    ]

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.7,
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('No response from OpenAI')
    }

    try {
      return JSON.parse(content) as ProjectResponse
    } catch (error) {
      throw new Error(`Failed to parse OpenAI response as JSON: ${error}`)
    }
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    // Clean up existing directory if it exists
    if (fs.existsSync(this.appDir)) {
      try {
        const nextDir = path.join(this.appDir, '.next')
        if (fs.existsSync(nextDir)) {
          await fs.promises.rm(nextDir, { recursive: true, force: true })
        }
        await fs.promises.rm(this.appDir, { recursive: true, force: true })
        // Wait a moment to ensure directory is fully deleted
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch (error) {
        console.warn('⚠ Warning: Could not fully clean directory, continuing anyway...')
      }
    }
    // Ensure parent directory exists and create app directory
    const parentDir = path.dirname(this.appDir)
    if (!fs.existsSync(parentDir)) {
      await fs.promises.mkdir(parentDir, { recursive: true })
    }
    await fs.promises.mkdir(this.appDir, { recursive: true })

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(this.appDir, filePath)
      const dir = path.dirname(fullPath)
      
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(fullPath, content, 'utf-8')
    }
  }
}

