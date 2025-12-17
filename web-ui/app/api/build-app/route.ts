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

    const runNpmInstallWithFallback = async (): Promise<void> => {
      log('Running npm install...')
      const first = await runNpm(['install'], 'npm install')
      if (first.code === 0) {
        log('npm install completed successfully')
        return
      }

      log('Regular npm install failed, trying with --legacy-peer-deps...')
      const second = await runNpm(['install', '--legacy-peer-deps'], 'npm install --legacy-peer-deps')
      if (second.code === 0) {
        log('npm install completed successfully (with --legacy-peer-deps)')
        return
      }

      throw new Error(`npm install failed.\n\n${second.output || first.output}`)
    }

    const runCompileGate = async (): Promise<{ ok: boolean; output: string }> => {
      log('Running compile gate: npm run build (next build)...')
      const res = await runNpm(['run', 'build'], 'npm run build')
      return { ok: res.code === 0, output: res.output }
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
      const buildRes = await runCompileGate()
      if (buildRes.ok) {
        log('Compile gate passed (next build succeeded)')
        break
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
  }
}

