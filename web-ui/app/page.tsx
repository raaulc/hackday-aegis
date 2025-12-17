'use client'

import { useState } from 'react'
import ImageUpload from './components/ImageUpload'
import StatusDisplay from './components/StatusDisplay'

export default function Home() {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'extracting' | 'generating' | 'building' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [extractedText, setExtractedText] = useState('')
  const [error, setError] = useState('')

  const handleImageUpload = async (file: File) => {
    // Reset prior run state so a new upload always restarts the full flow
    setExtractedText('')
    setStatus('uploading')
    setMessage('Uploading image...')
    setError('')

    try {
      // Convert image to base64
      const base64 = await fileToBase64(file)

      // Extract text from image
      setStatus('extracting')
      setMessage('Extracting text from image...')
      
      const extractResponse = await fetch('/api/extract-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      })

      if (!extractResponse.ok) {
        const errorData = await extractResponse.json().catch(() => ({}))
        throw new Error(errorData.error || `Failed to extract text: ${extractResponse.status} ${extractResponse.statusText}`)
      }

      const { text } = await extractResponse.json()
      setExtractedText(text)

      // Generate app
      setStatus('generating')
      setMessage('Generating app from requirements...')
      
      const generateResponse = await fetch('/api/generate-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      })

      if (!generateResponse.ok) {
        const errorData = await generateResponse.json()
        throw new Error(errorData.error || 'Failed to generate app')
      }

      const result = await generateResponse.json()
      
      // Build app
      setStatus('building')
      setMessage('Building and starting app...')
      
      // Build app (guard with timeout so UI can't get stuck forever)
      const controller = new AbortController()
      const buildTimeout = window.setTimeout(() => controller.abort(), 180_000) // 3 minutes
      const buildResponse = await fetch('/api/build-app', {
        method: 'POST',
        signal: controller.signal,
      }).finally(() => window.clearTimeout(buildTimeout))

      if (!buildResponse.ok) {
        const errorData = await buildResponse.json().catch(() => ({}))
        const errorMessage = errorData.error || `Failed to build app: ${buildResponse.status} ${buildResponse.statusText}`
        const logs = errorData.logs || ''
        const stdout = errorData.stdout || ''
        const stderr = errorData.stderr || ''
        
        let fullError = errorMessage
        if (logs) {
          fullError += `\n\nLogs:\n${logs}`
        }
        if (stdout) {
          fullError += `\n\nStdout:\n${stdout}`
        }
        if (stderr) {
          fullError += `\n\nStderr:\n${stderr}`
        }
        
        throw new Error(fullError)
      }

      setStatus('success')
      setMessage(`App generated successfully! Running at http://localhost:3000`)
      
      // Open the app in a new tab after a short delay
      setTimeout(() => {
        window.open('http://localhost:3000', '_blank')
      }, 2000)

    } catch (err) {
      setStatus('error')
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Build step timed out (3 minutes). The app may still be starting on http://localhost:3000 — check that URL and re-try if needed.')
      } else {
        setError(err instanceof Error ? err.message : 'An unknown error occurred')
      }
      setMessage('')
    }
  }

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => {
        const result = reader.result as string
        // Remove data URL prefix (e.g., "data:image/jpeg;base64,")
        const base64 = result.split(',')[1]
        resolve(base64)
      }
      reader.onerror = (error) => reject(error)
    })
  }

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            AI App Builder
          </h1>
          <p className="text-gray-600">
            Upload a Miro screenshot with your app requirements and watch it come to life
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <ImageUpload
            onUpload={handleImageUpload}
            disabled={status === 'uploading' || status === 'extracting' || status === 'generating' || status === 'building'}
          />
        </div>

        {extractedText && (
          <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-3">Extracted Requirements</h2>
            <div className="bg-gray-50 p-4 rounded border border-gray-200">
              <pre className="whitespace-pre-wrap text-sm text-gray-700">{extractedText}</pre>
            </div>
          </div>
        )}

        <StatusDisplay status={status} message={message} error={error} />
      </div>
    </main>
  )
}

