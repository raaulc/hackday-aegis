import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AI App Builder - From Screenshot to App',
  description: 'Upload a Miro screenshot and generate a Next.js app automatically',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">{children}</body>
    </html>
  )
}

