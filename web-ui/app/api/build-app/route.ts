import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import http from 'http'

export async function POST() {
  const logs: string[] = []
  const log = (message: string) => {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    logs.push(logMessage)
  }

  try {
    log('Starting build process...')
    
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

    log('Running npm install...')
    // Run npm install, with fallback to --legacy-peer-deps if needed
    let installSucceeded = false
    let installOutput = ''
    
    const runNpmInstall = async (useLegacyPeerDeps: boolean = false): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        const args = useLegacyPeerDeps ? ['install', '--legacy-peer-deps'] : ['install']
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
          log(`npm install stdout: ${text.trim()}`)
        })

        proc.stderr?.on('data', (data) => {
          const text = data.toString()
          output += text
          log(`npm install stderr: ${text.trim()}`)
        })

        proc.on('close', (code) => {
          if (code === 0) {
            log(`npm install completed successfully${useLegacyPeerDeps ? ' (with --legacy-peer-deps)' : ''}`)
            resolve()
          } else {
            log(`ERROR: npm install failed with exit code ${code}`)
            log(`npm install output: ${output}`)
            installOutput = output
            reject(new Error(`npm install failed with code ${code}\n${output}`))
          }
        })

        proc.on('error', (error) => {
          log(`ERROR: Failed to spawn npm install process: ${error.message}`)
          reject(error)
        })
      })
    }
    
    // Try regular install first
    try {
      await runNpmInstall(false)
      installSucceeded = true
    } catch (error) {
      log('Regular npm install failed, trying with --legacy-peer-deps...')
      // If it failed with peer dependency issues, try with --legacy-peer-deps
      if (installOutput.includes('ERESOLVE') || installOutput.includes('peer dependency')) {
        try {
          await runNpmInstall(true)
          installSucceeded = true
        } catch (legacyError) {
          log('npm install with --legacy-peer-deps also failed')
          throw legacyError
        }
      } else {
        throw error
      }
    }
    
    if (!installSucceeded) {
      throw new Error('npm install failed with all methods')
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
    
    // Wait up to 30 seconds for server to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      log(`Checking server readiness (attempt ${i + 1}/30)...`)
      
      // Check if server is responding using http
      const serverStatus = await new Promise<{ ready: boolean; statusCode: number | null }>((resolve) => {
        const req = http.request({
          hostname: 'localhost',
          port: 3000,
          path: '/',
          method: 'HEAD',
          timeout: 1000
        }, (res) => {
          const statusCode = res.statusCode || 0
          log(`Server responded with status code: ${statusCode}`)
          resolve({ ready: statusCode >= 200 && statusCode < 500, statusCode })
        })
        
        req.on('error', (err) => {
          log(`Server check error: ${err.message}`)
          resolve({ ready: false, statusCode: null })
        })
        req.on('timeout', () => {
          log('Server check timed out')
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

