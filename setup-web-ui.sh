#!/bin/bash

# Setup script for web UI

echo "🚀 Setting up AI Builder Web UI..."

# Check if .env exists in root
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found in root directory"
    echo "   Please create .env with: OPENAI_API_KEY=your_key_here"
    exit 1
fi

# Copy .env to web-ui/.env.local
echo "📋 Copying .env to web-ui/.env.local..."
cp .env web-ui/.env.local

# Install web-ui dependencies
echo "📦 Installing web-ui dependencies..."
cd web-ui
npm install

echo "✅ Setup complete!"
echo ""
echo "To start the web UI, run:"
echo "  cd web-ui && npm run dev"
echo ""
echo "Or from the root directory:"
echo "  npm run web-ui"
echo ""
echo "Then open http://localhost:3001 in your browser"

