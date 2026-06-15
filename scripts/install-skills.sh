#!/bin/bash

# DataBento Skills Installation Script
# Installs prebuilt DataBento skills to ~/.claude/skills/

set -e

echo "📦 Installing DataBento Skills..."

# Define paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKILLS_SRC="$PROJECT_ROOT/skills"
SKILLS_DIST="$PROJECT_ROOT/dist/skills"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
TARGET_DIR="$CLAUDE_SKILLS_DIR/databento"

# Ensure Claude skills directory exists
if [ ! -d "$CLAUDE_SKILLS_DIR" ]; then
  echo "⚠️  Creating ~/.claude/skills directory..."
  mkdir -p "$CLAUDE_SKILLS_DIR"
fi

# Remove old installation if exists
if [ -d "$TARGET_DIR" ]; then
  echo "🗑️  Removing old installation..."
  rm -rf "$TARGET_DIR"
fi

# Create target directory
echo "📁 Creating target directory..."
mkdir -p "$TARGET_DIR/scripts"

# Copy compiled scripts
echo "📋 Copying compiled scripts..."
if [ -d "$SKILLS_DIST/skills/databento/scripts" ]; then
  cp -r "$SKILLS_DIST/skills/databento/scripts/"* "$TARGET_DIR/scripts/"
elif [ -f "$PROJECT_ROOT/tsconfig.skills.json" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
  echo "🔨 Compiled skills not found; building skills first..."
  (cd "$PROJECT_ROOT" && npm run build:skills)
  cp -r "$SKILLS_DIST/skills/databento/scripts/"* "$TARGET_DIR/scripts/"
else
  echo "❌ Error: Compiled skills not found. Reinstall the published package or run this from a source checkout with build files."
  exit 1
fi

# The compiled files are emitted under dist/skills/skills/databento/scripts and
# therefore import shared code as ../../../src. After installation, scripts live
# in databento/scripts next to databento/src, so runtime imports must be local.
for script_file in "$TARGET_DIR"/scripts/*.js; do
  sed -i.bak 's#../../../src/#../src/#g' "$script_file"
  rm -f "$script_file.bak"
done

# Copy SKILL.md
echo "📄 Copying SKILL.md..."
cp "$SKILLS_SRC/databento/SKILL.md" "$TARGET_DIR/"

# Copy manifest.json
echo "📋 Copying manifest.json..."
cp "$SKILLS_SRC/manifest.json" "$TARGET_DIR/"

# Copy shared src files (needed at runtime)
echo "📦 Copying shared source files..."
mkdir -p "$TARGET_DIR/src"
cp -r "$SKILLS_DIST/src/"* "$TARGET_DIR/src/" 2>/dev/null || true

# Make scripts executable
echo "🔧 Making scripts executable..."
chmod +x "$TARGET_DIR/scripts/"*.js

# Update master manifest if it exists
MASTER_MANIFEST="$CLAUDE_SKILLS_DIR/manifest.json"
if [ -f "$MASTER_MANIFEST" ]; then
  echo "📝 Updating master manifest..."
  # Backup existing manifest
  cp "$MASTER_MANIFEST" "$MASTER_MANIFEST.backup"

  # Check if jq is available
  if command -v jq &> /dev/null; then
    # Use jq to merge databento skill into master manifest (idempotent)
    # Remove existing databento entry if present, then add the new one
    jq --arg skillPath "databento/SKILL.md" \
       'del(.skills[] | select(.name == "databento")) |
        .skills += [{
          "name": "databento",
          "path": "databento/SKILL.md",
          "description": "Professional market data access via DataBento API",
          "version": "1.0.0",
          "type": "data-api",
          "scripts": [
            {"name": "get-quote", "path": "databento/scripts/get-quote.js", "description": "Get real-time futures quotes"},
            {"name": "get-historical", "path": "databento/scripts/get-historical.js", "description": "Get historical OHLCV bars"},
            {"name": "get-session", "path": "databento/scripts/get-session.js", "description": "Get trading session info"},
            {"name": "resolve-symbols", "path": "databento/scripts/resolve-symbols.js", "description": "Resolve symbols"},
            {"name": "timeseries", "path": "databento/scripts/timeseries.js", "description": "Get timeseries data"},
            {"name": "metadata", "path": "databento/scripts/metadata.js", "description": "Query metadata"},
            {"name": "batch", "path": "databento/scripts/batch.js", "description": "Manage batch jobs"},
            {"name": "reference", "path": "databento/scripts/reference.js", "description": "Access reference data"}
          ]
        }]' "$MASTER_MANIFEST" > "$MASTER_MANIFEST.tmp" && mv "$MASTER_MANIFEST.tmp" "$MASTER_MANIFEST"
    echo "✅ Master manifest updated with databento skill"
  else
    echo "⚠️  jq not found. Please manually add databento to $MASTER_MANIFEST"
  fi
fi

echo "✅ DataBento skills installed successfully!"
echo ""
echo "📍 Installation location: $TARGET_DIR"
echo ""
echo "🔑 Don't forget to set DATABENTO_API_KEY environment variable:"
echo "   export DATABENTO_API_KEY='db-your-api-key-here'"
echo ""
echo "🧪 Test the installation with:"
echo "   node $TARGET_DIR/scripts/get-quote.js ES"
echo ""
