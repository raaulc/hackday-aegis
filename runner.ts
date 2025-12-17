#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import open from "open";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Error: OPENAI_API_KEY not found in environment variables");
  console.error("   Create a .env file with: OPENAI_API_KEY=your_key_here");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const APP_DIR = path.join(__dirname, "generated-app");
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");

interface ProjectResponse {
  port: number;
  files: Record<string, string>;
}

async function readSystemPrompt(): Promise<string> {
  try {
    return await fs.promises.readFile(SYSTEM_PROMPT_PATH, "utf-8");
  } catch (error) {
    console.error("❌ Error reading system prompt:", error);
    process.exit(1);
  }
}

async function callOpenAI(userPrompt: string, systemPrompt: string, errorContext?: string): Promise<ProjectResponse> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: errorContext ? `${userPrompt}\n\nError occurred:\n${errorContext}\n\nPlease fix the errors and return only the changed files.` : userPrompt }
  ];

  console.log("🤖 Calling OpenAI...");
  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from OpenAI");
  }

  try {
    return JSON.parse(content) as ProjectResponse;
  } catch (error) {
    throw new Error(`Failed to parse OpenAI response as JSON: ${error}`);
  }
}

async function writeFiles(files: Record<string, string>, appDir: string): Promise<void> {
  console.log("📝 Writing files to disk...");
  
  // Clean up existing directory if it exists
  if (fs.existsSync(appDir)) {
    try {
      // Try to remove .next directory first if it exists (can be locked)
      const nextDir = path.join(appDir, ".next");
      if (fs.existsSync(nextDir)) {
        await fs.promises.rm(nextDir, { recursive: true, force: true });
      }
      await fs.promises.rm(appDir, { recursive: true, force: true });
    } catch (error) {
      // If cleanup fails, log but continue - we'll overwrite files anyway
      console.warn("⚠ Warning: Could not fully clean directory, continuing anyway...");
    }
  }
  await fs.promises.mkdir(appDir, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(appDir, filePath);
    const dir = path.dirname(fullPath);
    
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(fullPath, content, "utf-8");
    console.log(`   ✓ ${filePath}`);
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`🔧 Running: ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

async function runNpmInstall(appDir: string): Promise<void> {
  try {
    await runCommand("npm", ["install"], appDir);
    console.log("✅ npm install completed");
  } catch (error) {
    throw new Error(`npm install failed: ${error}`);
  }
}

function runNpmDev(appDir: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`🚀 Starting dev server on port ${port}...`);
    const proc = spawn("npm", ["run", "dev"], {
      cwd: appDir,
      stdio: "pipe",
      shell: process.platform === "win32",
    });

    let output = "";
    let errorOutput = "";
    let serverReady = false;
    let timeoutHandle: NodeJS.Timeout;

    const markReady = () => {
      if (!serverReady) {
        serverReady = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        setTimeout(() => {
          open(`http://localhost:${port}`).catch(console.error);
          console.log(`\n🌐 Opened http://localhost:${port} in your browser\n`);
          resolve();
        }, 1500);
      }
    };

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
      
      // Check if server is ready (Next.js messages)
      if (text.includes("Ready") || 
          text.includes(`Local:`) || 
          text.includes(`http://localhost:${port}`) ||
          text.includes(`http://0.0.0.0:${port}`)) {
        markReady();
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(text);
      
      // Sometimes Next.js puts ready messages in stderr
      if (text.includes("Ready") || text.includes(`Local:`)) {
        markReady();
      }
    });

    proc.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    });

    proc.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (code !== 0 && code !== null && !serverReady) {
        reject(new Error(`Dev server exited with code ${code}\n${errorOutput}`));
      }
    });

    // Timeout after 30 seconds if server doesn't start
    timeoutHandle = setTimeout(() => {
      if (!serverReady) {
        reject(new Error("Dev server failed to start within 30 seconds"));
      }
    }, 30000);
  });
}

async function handleError(
  error: Error,
  userPrompt: string,
  systemPrompt: string,
  appDir: string,
  port: number
): Promise<void> {
  console.error("\n❌ Error occurred:", error.message);
  console.log("🔄 Attempting to fix...");

  try {
    const errorContext = `Error: ${error.message}\n\nIMPORTANT: You must return ALL required files for a complete Next.js app, including package.json, tsconfig.json, next.config.js, tailwind.config.js, postcss.config.js, app/layout.tsx, app/page.tsx, and app/globals.css. Do not return partial files. Return the complete fixed project as a full JSON response with all files.`;
    const fixedProject = await callOpenAI(userPrompt, systemPrompt, errorContext);
    
    await writeFiles(fixedProject.files, appDir);
    await runNpmInstall(appDir);
    
    console.log("✅ Fix applied, restarting...");
    // This will keep the process alive until server is ready, then we let it run
    await runNpmDev(appDir, fixedProject.port || port);
    
    // Keep process alive (dev server is running in background)
    console.log("\n✨ App is running! Press Ctrl+C to stop.\n");
    return new Promise(() => {}); // Never resolves, keeps process alive
  } catch (fixError) {
    console.error("❌ Failed to auto-fix:", fixError);
    console.error("\n💡 Manual fix required. Check the generated-app/ directory.");
    process.exit(1);
  }
}

async function main() {
  const userPrompt = process.argv.slice(2).join(" ");
  
  if (!userPrompt) {
    console.error("Usage: npm start <your prompt>");
    console.error("Example: npm start 'Build me a todo app'");
    process.exit(1);
  }

  console.log(`📋 Prompt: ${userPrompt}\n`);

  try {
    const systemPrompt = await readSystemPrompt();
    const project = await callOpenAI(userPrompt, systemPrompt);
    
    await writeFiles(project.files, APP_DIR);
    await runNpmInstall(APP_DIR);
    await runNpmDev(APP_DIR, project.port || 3000);
    
    console.log("\n✨ App is running! Press Ctrl+C to stop.\n");
    
    // Keep process alive (wait indefinitely)
    process.on("SIGINT", () => {
      console.log("\n👋 Shutting down...");
      process.exit(0);
    });
    
    // Keep process alive - wait indefinitely
    await new Promise(() => {});
    
  } catch (error) {
    if (error instanceof Error) {
      const systemPrompt = await readSystemPrompt();
      await handleError(error, userPrompt, systemPrompt, APP_DIR, 3000);
    } else {
      console.error("❌ Unexpected error:", error);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

