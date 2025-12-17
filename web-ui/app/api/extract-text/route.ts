import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

export async function POST(request: NextRequest) {
  try {
    const { image } = await request.json()

    if (!image) {
      return NextResponse.json(
        { error: 'No image provided' },
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

    const openai = new OpenAI({ apiKey })
    
    // Ensure image is in the correct format
    let imageUrl: string
    if (image.startsWith('data:')) {
      imageUrl = image
    } else {
      // Assume it's base64, use PNG format
      imageUrl = `data:image/png;base64,${image}`
    }
    
    // Try gpt-4o first, fallback to gpt-4-turbo if needed
    let response
    try {
      response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract all text from this image. This is a screenshot from Miro or a design tool with requirements/instructions for building an app. Extract all the text content, instructions, requirements, and specifications. Return only the extracted text, no additional commentary."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        max_tokens: 2000,
      })
    } catch (modelError: any) {
      // If gpt-4o fails, try gpt-4-turbo
      if (modelError?.code === 'model_not_found' || modelError?.message?.includes('gpt-4o')) {
        console.log('gpt-4o not available, trying gpt-4-turbo')
        response = await openai.chat.completions.create({
          model: "gpt-4-turbo",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract all text from this image. This is a screenshot from Miro or a design tool with requirements/instructions for building an app. Extract all the text content, instructions, requirements, and specifications. Return only the extracted text, no additional commentary."
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageUrl,
                  },
                },
              ],
            },
          ],
          max_tokens: 2000,
        })
      } else {
        throw modelError
      }
    }

    const text = response.choices[0]?.message?.content
    if (!text) {
      throw new Error('No text extracted from image')
    }

    return NextResponse.json({ text })
  } catch (error) {
    console.error('Error extracting text:', error)
    const errorMessage = error instanceof Error ? error.message : 'Failed to extract text'
    const errorDetails = error instanceof Error && 'response' in error 
      ? JSON.stringify((error as any).response, null, 2)
      : undefined
    
    console.error('Error details:', errorDetails)
    
    return NextResponse.json(
      { 
        error: errorMessage,
        details: errorDetails
      },
      { status: 500 }
    )
  }
}

