import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { AppBuilder } from '../../../lib/app-builder'

export async function POST(request: NextRequest) {
  const logs: string[] = []
  const log = (message: string) => {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    logs.push(logMessage)
  }

  try {
    log('Starting build process...')

    // Optional: prompt used for auto-repair when compile gate fails
    let prompt: string | undefined
    try {
      const body = await request.json().catch(() => null)
      if (body && typeof body.prompt === 'string') {
        prompt = body.prompt
      }
    } catch {
      // ignore
    }
    
    // generated-app is in the parent directory (hackday/generated-app)
    const appDir = path.join(process.cwd(), '..', 'generated-app')
    log(`App directory: ${appDir}`)

    // Single-flight lock: prevent concurrent builds/installations in the same generated-app folder.
    const lockPath = path.join(appDir, '.build.lock')
    let lockFd: fs.promises.FileHandle | null = null
    try {
      lockFd = await fs.promises.open(lockPath, 'wx')
      await lockFd.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      log(`Acquired build lock: ${lockPath}`)
    } catch (e: any) {
      log(`ERROR: Build already in progress (lock exists): ${lockPath}`)
      return NextResponse.json(
        {
          error: 'Build already in progress. Please wait for the current build to finish and try again.',
          logs: logs.join('\n'),
        },
        { status: 409 }
      )
    }

    if (!fs.existsSync(appDir)) {
      log(`ERROR: App directory does not exist: ${appDir}`)
      return NextResponse.json(
        { 
          error: 'Generated app directory not found',
          logs: logs.join('\n')
        },
        { status: 404 }
      )
    }

    const runNpm = async (args: string[], label: string): Promise<{ code: number; output: string }> => {
      return await new Promise((resolve) => {
        log(`Running: npm ${args.join(' ')}`)
        const proc = spawn('npm', args, {
          cwd: appDir,
          stdio: 'pipe',
          shell: process.platform === 'win32',
        })

        let output = ''
        proc.stdout?.on('data', (data) => {
          const text = data.toString()
          output += text
          log(`${label} stdout: ${text.trim()}`)
        })

        proc.stderr?.on('data', (data) => {
          const text = data.toString()
          output += text
          log(`${label} stderr: ${text.trim()}`)
        })

        proc.on('close', (code) => resolve({ code: code ?? 1, output }))
        proc.on('error', (error) => resolve({ code: 1, output: `${output}\n${label} spawn error: ${error.message}` }))
      })
    }

    const looksLikeCorruptInstall = (output: string) => {
      const signals = [
        'TAR_ENTRY_ERROR',
        'ENOENT: no such file or directory, open',
        'Cannot find module',
        '@swc/helpers',
        'caniuse-lite/dist/unpacker/agents',
      ]
      return signals.some((s) => output.includes(s))
    }

    const cleanGeneratedAppBuildState = async (reason: string) => {
      log(`Cleaning generated-app build state due to: ${reason}`)
      // Remove build output cache
      await fs.promises.rm(path.join(appDir, '.next'), { recursive: true, force: true }).catch(() => {})
      // If install is corrupted, wipe node_modules (and lockfile if present to allow a full refresh)
      await fs.promises.rm(path.join(appDir, 'node_modules'), { recursive: true, force: true }).catch(() => {})
      await fs.promises.rm(path.join(appDir, 'package-lock.json'), { force: true }).catch(() => {})
      await fs.promises.rm(path.join(appDir, '.install.hash'), { force: true }).catch(() => {})
    }

    const computeInstallHash = async (): Promise<string> => {
      const pkgPath = path.join(appDir, 'package.json')
      const lockPath = path.join(appDir, 'package-lock.json')
      const pkg = await fs.promises.readFile(pkgPath, 'utf-8').catch(() => '')
      const lock = await fs.promises.readFile(lockPath, 'utf-8').catch(() => '')
      // Lightweight stable hash without crypto dependency
      const data = `${pkg}\n---\n${lock}`
      let h = 0
      for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) >>> 0
      return String(h)
    }

    const runNpmInstallWithFallback = async (): Promise<void> => {
      const desiredHash = await computeInstallHash()
      const lastHashPath = path.join(appDir, '.install.hash')
      const lastHash = await fs.promises.readFile(lastHashPath, 'utf-8').catch(() => '')

      if (lastHash.trim() === desiredHash && fs.existsSync(path.join(appDir, 'node_modules'))) {
        log('Dependencies unchanged; skipping install')
        return
      }

      const hasLock = fs.existsSync(path.join(appDir, 'package-lock.json'))
      const installCmd = hasLock ? ['ci'] : ['install']
      const label = hasLock ? 'npm ci' : 'npm install'

      log(`Running ${label}...`)
      const first = await runNpm(installCmd, label)
      if (first.code === 0) {
        log(`${label} completed successfully`)
        await fs.promises.writeFile(lastHashPath, desiredHash).catch(() => {})
        return
      }

      if (looksLikeCorruptInstall(first.output)) {
        await cleanGeneratedAppBuildState(`${label} appears corrupted`)
        log(`Retrying ${label} after cleaning...`)
        const retry = await runNpm(installCmd, `${label} (retry)`)
        if (retry.code === 0) {
          log(`${label} completed successfully after cleaning`)
          await fs.promises.writeFile(lastHashPath, desiredHash).catch(() => {})
          return
        }
        throw new Error(`${label} failed even after cleaning.\n\n${retry.output}`)
      }

      // Fallback for peer deps conflicts (only for npm install)
      if (!hasLock) {
        log('Regular npm install failed, trying with --legacy-peer-deps...')
        const second = await runNpm(['install', '--legacy-peer-deps'], 'npm install --legacy-peer-deps')
        if (second.code === 0) {
          log('npm install completed successfully (with --legacy-peer-deps)')
          await fs.promises.writeFile(lastHashPath, desiredHash).catch(() => {})
          return
        }
        if (looksLikeCorruptInstall(second.output)) {
          await cleanGeneratedAppBuildState('npm install fallback appears corrupted')
        }
        throw new Error(`npm install failed.\n\n${second.output || first.output}`)
      }

      throw new Error(`${label} failed.\n\n${first.output}`)
    }

    const runCompileGate = async (): Promise<{ ok: boolean; output: string }> => {
      log('Running compile gate: npm run build (next build)...')
      const res = await runNpm(['run', 'build'], 'npm run build')
      return { ok: res.code === 0, output: res.output }
    }

    const findForbiddenNextDocumentUsage = async (): Promise<string | null> => {
      // Fast fail for the most common LLM mistake: importing Pages Router _document APIs in App Router.
      // We scan a small set of high-signal files plus a repo-wide fallback.
      const candidates = [
        path.join(appDir, 'app', 'layout.tsx'),
        path.join(appDir, 'app', 'page.tsx'),
        path.join(appDir, 'app', 'layout.jsx'),
        path.join(appDir, 'app', 'page.jsx'),
        path.join(appDir, 'pages', '_document.tsx'),
        path.join(appDir, 'pages', '_document.jsx'),
      ]

      const forbiddenPatterns: Array<{ label: string; re: RegExp }> = [
        { label: "import from 'next/document'", re: /from\s+['"]next\/document['"]/ },
        { label: '<Html> usage', re: /<\s*Html\b/ },
        { label: '<Head> usage (next/document)', re: /<\s*Head\b/ },
        { label: '<Main> usage', re: /<\s*Main\b/ },
        { label: '<NextScript> usage', re: /<\s*NextScript\b/ },
      ]

      const checkContent = (filePath: string, content: string): string | null => {
        for (const p of forbiddenPatterns) {
          if (p.re.test(content)) return `${p.label} found in ${path.relative(appDir, filePath)}`
        }
        return null
      }

      for (const filePath of candidates) {
        if (!fs.existsSync(filePath)) continue
        const content = await fs.promises.readFile(filePath, 'utf-8').catch(() => '')
        const hit = checkContent(filePath, content)
        if (hit) return hit
      }

      // Fallback: scan the appDir tree for next/document usage.
      const walk = async (dir: string): Promise<string | null> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const ent of entries) {
          if (ent.name === 'node_modules' || ent.name === '.next') continue
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            const found = await walk(full)
            if (found) return found
          } else if (/\.(ts|tsx|js|jsx|mdx)$/.test(ent.name)) {
            const content = await fs.promises.readFile(full, 'utf-8').catch(() => '')
            const hit = checkContent(full, content)
            if (hit) return hit
          }
        }
        return null
      }

      return await walk(appDir)
    }

    const maybeAutoRepair = async (errorContext: string): Promise<boolean> => {
      if (!prompt) return false
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) return false

      const builder = new AppBuilder(apiKey)
      log('Attempting auto-repair via OpenAI (compile gate failed)...')
      const repaired = await builder.generateApp(prompt, errorContext)
      await builder.writeFiles(repaired.files)
      return true
    }

    // Install deps first (needed for build)
    await runNpmInstallWithFallback()

    // Strict compile gate with up to 2 auto-repair attempts
    const MAX_REPAIR_ATTEMPTS = 2
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      const forbidden = await findForbiddenNextDocumentUsage()
      if (forbidden) {
        log(`Forbidden Next.js usage detected before build: ${forbidden}`)
        if (attempt === MAX_REPAIR_ATTEMPTS) {
          return NextResponse.json(
            {
              error: `Forbidden Next.js usage detected: ${forbidden}`,
              logs: logs.join('\n'),
              suggestion:
                "Remove any use of next/document or <Html>/<Head>/<Main>/<NextScript>. This project uses App Router; only use lowercase <html>/<body> in app/layout.tsx.",
            },
            { status: 500 }
          )
        }

        const repaired = await maybeAutoRepair(
          `FORBIDDEN NEXT.JS USAGE DETECTED: ${forbidden}\n\nThis project uses Next.js App Router (app/). You MUST remove all imports from 'next/document' and remove any usage of <Html>, <Head>, <Main>, <NextScript> components.\n\nFix the project and return the full corrected JSON with ALL required files.`
        )
        if (!repaired) {
          return NextResponse.json(
            {
              error: 'Forbidden Next.js usage detected and auto-repair was not possible (missing prompt or OPENAI_API_KEY)',
              logs: logs.join('\n'),
              suggestion:
                "Provide the prompt to /api/build-app and ensure OPENAI_API_KEY is configured so auto-repair can run.",
            },
            { status: 500 }
          )
        }
        await runNpmInstallWithFallback()
        continue
      }

      const buildRes = await runCompileGate()
      if (buildRes.ok) {
        log('Compile gate passed (next build succeeded)')
        break
      }

      if (looksLikeCorruptInstall(buildRes.output)) {
        await cleanGeneratedAppBuildState('next build indicates missing/corrupt dependencies')
        await runNpmInstallWithFallback()
        continue
      }

      const attemptLabel = attempt === 0 ? 'initial build' : `repair attempt ${attempt}`
      log(`Compile gate failed (${attemptLabel})`)

      if (attempt === MAX_REPAIR_ATTEMPTS) {
        return NextResponse.json(
          {
            error: 'Compile gate failed: next build did not succeed',
            logs: logs.join('\n'),
            stderr: buildRes.output,
            suggestion: 'The generated app has a compile error. Try regenerating or inspect generated-app/app/page.tsx around the reported line.',
          },
          { status: 500 }
        )
      }

      const repaired = await maybeAutoRepair(
        `next build failed (attempt ${attempt + 1}/${MAX_REPAIR_ATTEMPTS}). Here is the full output:\n\n${buildRes.output}`
      )
      if (!repaired) {
        // If we can't repair (missing prompt or API key), fail immediately
        return NextResponse.json(
          {
            error: 'Compile gate failed and auto-repair was not possible (missing prompt or OPENAI_API_KEY)',
            logs: logs.join('\n'),
            stderr: buildRes.output,
          },
          { status: 500 }
        )
      }

      // Dependencies may have changed during repair; reinstall then retry build
      await runNpmInstallWithFallback()
    }

    // Check if port 3000 is already in use - kill any existing process (but not 3001 - that's the web UI)
    log('Checking if port 3000 is in use...')
    try {
      const { exec } = await import('child_process')
      const { promisify } = await import('util')
      const execAsync = promisify(exec)
      
      // Only kill processes on port 3000 (generated app port)
      try {
        if (process.platform === 'darwin') {
          log('Attempting to kill process on port 3000 (macOS)...')
          try {
            const result = await execAsync(`lsof -ti:3000 2>/dev/null`)
            if (result.stdout.trim()) {
              const pids = result.stdout.trim().split('\n').filter(pid => pid)
              log(`Found processes on port 3000: ${pids.join(', ')}`)
              await execAsync(`kill -9 ${pids.join(' ')} 2>/dev/null || true`)
              log('Killed existing processes on port 3000')
            } else {
              log('No processes found on port 3000')
            }
          } catch (e: any) {
            if (e.code !== 1) { // code 1 means no processes found, which is fine
              log(`Error checking port 3000: ${e.message}`)
            } else {
              log('No processes found on port 3000')
            }
          }
        } else if (process.platform === 'win32') {
          log('Attempting to kill process on port 3000 (Windows)...')
          await execAsync(`netstat -ano | findstr :3000`)
        } else {
          log('Attempting to kill process on port 3000 (Linux)...')
          await execAsync(`fuser -k 3000/tcp 2>/dev/null || true`)
        }
        // Wait a moment for port to be released
        log('Waiting 1 second for port 3000 to be released...')
        await new Promise(resolve => setTimeout(resolve, 1000))
      } catch (e: any) {
        log(`Port 3000 cleanup result: ${e.message || 'No processes to kill'}`)
      }
    } catch (e: any) {
      log(`Warning: Could not check/kill processes on port 3000: ${e.message}`)
    }

    log('Starting Next.js dev server on port 3000...')
    // Start dev server in background, explicitly on port 3000
    const proc = spawn('npm', ['run', 'dev', '--', '-p', '3000'], {
      cwd: appDir,
      stdio: 'pipe',
      detached: true,
      shell: process.platform === 'win32',
    })

    log(`Dev server process started with PID: ${proc.pid}`)

    let serverReady = false
    let errorOutput = ''
    let stdOutput = ''

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      stdOutput += text
      log(`Dev server stdout: ${text.trim()}`)
      if (text.includes('Ready') || text.includes('Local:') || text.includes('localhost:3000') || text.includes('started server')) {
        log('Server ready signal detected in stdout')
        serverReady = true
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      errorOutput += text
      log(`Dev server stderr: ${text.trim()}`)
      if (text.includes('Ready') || text.includes('Local:')) {
        log('Server ready signal detected in stderr')
        serverReady = true
      }
    })

    proc.on('error', (error) => {
      log(`ERROR: Failed to start dev server process: ${error.message}`)
      log(`Process error details: ${JSON.stringify(error, null, 2)}`)
      throw error
    })

    proc.on('exit', (code, signal) => {
      log(`WARNING: Dev server process exited with code ${code}, signal ${signal}`)
      log(`Stdout output: ${stdOutput}`)
      log(`Stderr output: ${errorOutput}`)
    })

    proc.unref() // Allow parent process to exit independently
    log('Process detached from parent')

    log('Waiting for server to be ready (checking every second, max 30 seconds)...')
    // Track consecutive 500 errors to detect compilation failures early
    let consecutive500Errors = 0
    const MAX_CONSECUTIVE_500 = 5 // If we get 5 consecutive 500s, likely a compilation error
    const HEALTHCHECK_HOST = '127.0.0.1' // avoid IPv6 ::1 flakiness on some setups
    const HEALTHCHECK_TIMEOUT_MS = 3000 // Next dev server can take >1s during initial compile
    
    // Wait up to 30 seconds for server to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      log(`Checking server readiness (attempt ${i + 1}/30)...`)
      
      // Check if server is responding using http
      const serverStatus = await new Promise<{ ready: boolean; statusCode: number | null }>((resolve) => {
        const req = http.request(
          {
            hostname: HEALTHCHECK_HOST,
            port: 3000,
            path: '/',
            method: 'GET',
            timeout: HEALTHCHECK_TIMEOUT_MS,
          },
          (res) => {
            const statusCode = res.statusCode || 0
            // Drain response to avoid socket hang ups on keep-alive connections
            res.resume()
            log(`Server responded with status code: ${statusCode}`)
            resolve({ ready: statusCode >= 200 && statusCode < 500, statusCode })
          }
        )
        
        req.on('error', (err) => {
          log(`Server check error: ${err.message}`)
          resolve({ ready: false, statusCode: null })
        })
        req.on('timeout', () => {
          log(`Server check timed out after ${HEALTHCHECK_TIMEOUT_MS}ms`)
          req.destroy()
          resolve({ ready: false, statusCode: null })
        })
        
        req.end()
      })
      
      // Check for consecutive 500 errors (compilation failures)
      if (serverStatus.statusCode === 500) {
        consecutive500Errors++
        log(`Received 500 error (${consecutive500Errors}/${MAX_CONSECUTIVE_500} consecutive)`)
        if (consecutive500Errors >= MAX_CONSECUTIVE_500) {
          log('ERROR: Server is consistently returning 500 errors - likely a compilation/build error')
          log(`Final stdout output: ${stdOutput}`)
          log(`Final stderr output: ${errorOutput}`)
          
          return NextResponse.json(
            { 
              error: 'Server started but is returning 500 errors. Likely a compilation/build error in the generated app.',
              logs: logs.join('\n'),
              stdout: stdOutput,
              stderr: errorOutput,
              pid: proc.pid,
              suggestion: 'Check the generated app files for errors. Common issues: missing "use client" directive, invalid imports, or syntax errors.'
            },
            { status: 500 }
          )
        }
      } else {
        consecutive500Errors = 0 // Reset counter on non-500 response
      }
      
      if (serverStatus.ready) {
        log('Server is ready and responding!')
        serverReady = true
        break
      }
    }

    if (!serverReady) {
      log('ERROR: Server failed to start within 30 seconds')
      log(`Final stdout output: ${stdOutput}`)
      log(`Final stderr output: ${errorOutput}`)
      log(`Process PID was: ${proc.pid}`)
      
      return NextResponse.json(
        { 
          error: 'Dev server failed to start within 30 seconds',
          logs: logs.join('\n'),
          stdout: stdOutput,
          stderr: errorOutput,
          pid: proc.pid
        },
        { status: 500 }
      )
    }

    log('Build process completed successfully')
    return NextResponse.json({ 
      success: true,
      message: 'App built and started successfully',
      url: 'http://localhost:3000',
      logs: logs.join('\n'),
      pid: proc.pid
    })
  } catch (error) {
    log(`FATAL ERROR: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack) {
      log(`Stack trace: ${error.stack}`)
    }
    
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : 'Failed to build app',
        logs: logs.join('\n')
      },
      { status: 500 }
    )
  } finally {
    // Release lock
    try {
      const appDir = path.join(process.cwd(), '..', 'generated-app')
      const lockPath = path.join(appDir, '.build.lock')
      await fs.promises.rm(lockPath, { force: true }).catch(() => {})
    } catch {
      // ignore
    }
  }
}


