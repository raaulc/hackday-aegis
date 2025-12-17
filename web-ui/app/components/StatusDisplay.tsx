'use client'

interface StatusDisplayProps {
  status: 'idle' | 'uploading' | 'extracting' | 'generating' | 'building' | 'success' | 'error'
  message: string
  error?: string
}

export default function StatusDisplay({ status, message, error }: StatusDisplayProps) {
  if (status === 'idle') return null

  const getStatusColor = () => {
    switch (status) {
      case 'success':
        return 'bg-green-50 border-green-200 text-green-800'
      case 'error':
        return 'bg-red-50 border-red-200 text-red-800'
      default:
        return 'bg-blue-50 border-blue-200 text-blue-800'
    }
  }

  const getStatusIcon = () => {
    switch (status) {
      case 'success':
        return (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'error':
        return (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        )
      default:
        return (
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-current"></div>
        )
    }
  }

  return (
      <div className={`rounded-lg border p-4 ${getStatusColor()}`}>
        <div className="flex items-center space-x-3">
          <div className="flex-shrink-0">{getStatusIcon()}</div>
          <div className="flex-1">
            {message && <p className="font-medium">{message}</p>}
            {error && (
              <div className="mt-2">
                <p className="text-sm font-semibold mb-2">Error:</p>
                <pre className="text-xs bg-black/10 dark:bg-white/10 p-3 rounded overflow-auto max-h-96 whitespace-pre-wrap break-words">
                  {error}
                </pre>
              </div>
            )}
          {status === 'building' && (
            <div className="mt-2 space-y-1">
              <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 rounded-full animate-pulse" style={{ width: '60%' }}></div>
              </div>
              <p className="text-xs mt-2">This may take a minute or two...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

