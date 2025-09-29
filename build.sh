#!/bin/bash

# CodeLab Extension Build Script
# This script builds the VS Code extension and creates a VSIX file

echo "🚀 CodeLab Extension Builder"
echo "=========================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check for Node.js
if ! command_exists node; then
    echo -e "${RED}❌ Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# Check for npm
if ! command_exists npm; then
    echo -e "${RED}❌ npm is not installed. Please install npm first.${NC}"
    exit 1
fi

echo "📦 Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi

echo ""
echo "🔨 Building and bundling extension..."
npm run package
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

echo ""
echo "📋 Packaging extension..."

# Use npx to run vsce from local node_modules
npx @vscode/vsce package
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to create VSIX package${NC}"
    exit 1
fi

# Find the generated VSIX file
VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -n 1)

if [ -z "$VSIX_FILE" ]; then
    echo -e "${RED}❌ VSIX file was not created${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Successfully built extension!${NC}"
echo ""
echo "📦 Output: ${YELLOW}$VSIX_FILE${NC}"
echo ""
echo "To install the extension locally, run:"
echo -e "${YELLOW}code --install-extension $VSIX_FILE${NC}"
echo ""
echo "To install in VS Code manually:"
echo "1. Open VS Code"
echo "2. Go to Extensions view (Ctrl+Shift+X / Cmd+Shift+X)"
echo "3. Click '...' menu → 'Install from VSIX...'"
echo "4. Select $VSIX_FILE"