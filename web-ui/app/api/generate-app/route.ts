import { NextRequest, NextResponse } from 'next/server'
import { AppBuilder } from '../../../lib/app-builder'

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json()

    if (!prompt) {
      return NextResponse.json(
        { error: 'No prompt provided' },
        { status: 400 }
      )
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY not configured' },
        { status: 500 }
      )
    }

    const builder = new AppBuilder(apiKey)
    
    console.log('📋 User prompt received:', prompt)
    console.log('📋 Prompt length:', prompt.length)
    
    const project = await builder.generateApp(prompt)
    
    console.log('✅ Generated project with files:', Object.keys(project.files))
    await builder.writeFiles(project.files)

    return NextResponse.json({ 
      success: true,
      message: 'App generated successfully',
      fileCount: Object.keys(project.files).length
    })
  } catch (error) {
    console.error('Error generating app:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate app' },
      { status: 500 }
    )
  }
}

